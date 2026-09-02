import { sendMessage, sendPhoto, InlineButton } from "./telegram";
import {
  UserEnv,
  getOrCreateUser,
  listActivePlans,
  choosePlan,
  listUserDeposits,
  requestWithdrawal,
  updateWithdrawalAddress,
} from "../user/actions";

interface Env extends UserEnv {
  TELEGRAM_GROUP_LINK?: string;
  WELCOME_IMAGE_URL?: string;
  ADMIN_TELEGRAM_CHAT_ID?: string;
}

async function setConversationState(env: Env, userId: number, state: string, data?: string) {
  await env.DB.prepare(
    `INSERT INTO conversation_state (user_id, state, data, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = datetime('now')`
  )
    .bind(userId, state, data ?? null)
    .run();
}

async function clearConversationState(env: Env, userId: number) {
  await env.DB.prepare("DELETE FROM conversation_state WHERE user_id = ?").bind(userId).run();
}

export async function getConversationState(env: Env, userId: number) {
  return env.DB.prepare("SELECT * FROM conversation_state WHERE user_id = ?").bind(userId).first<any>();
}

function formatPlanLine(plan: any) {
  const amount =
    plan.amount_type === "fixed" ? `${plan.amount_fixed} USDT` : `${plan.amount_min} – ${plan.amount_max} USDT`;
  return (
    `┏━━━━━━━━━━━━━━┓\n` +
    `┃ 📌 <b>${plan.name}</b>\n` +
    `┗━━━━━━━━━━━━━━┛\n` +
    `💵 Montant : <b>${amount}</b>\n` +
    `⏱ Durée : <b>${plan.duration_days} jours</b>\n` +
    `📈 Gain à l'échéance : <b>+${plan.gain_percent}%</b>`
  );
}

export async function handleHelp(env: Env, chatId: number) {
  await sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    `❓ <b>Aide</b>\n\n` +
      `📋 <b>Voir les plans</b> — choisir un plan et obtenir ton adresse de dépôt USDT (TRC20)\n` +
      `💰 <b>Mes dépôts</b> — suivre l'état de tes dépôts et retirer à échéance\n` +
      `⚙️ <b>Paramètres</b> — définir ton adresse de retrait\n\n` +
      `💡 Tu peux aussi tout gérer depuis le site web, avec le même compte.\n\n` +
      `📞 <b>Contacter un administrateur</b> — écris directement à l'équipe depuis le bot.`,
    [
      [{ text: "📞 Contacter un administrateur", callback_data: "contact_admin" }],
      [{ text: "🏠 Retour au menu", callback_data: "start" }],
    ]
  );
}

export async function handleStart(env: Env, chatId: number, from: any) {
  await getOrCreateUser(env, from.id, from.username, from.first_name);

  const name = from.first_name ? `, ${from.first_name}` : "";
  const welcomeText =
    `👋 <b>Bienvenue${name} !</b>\n\n` +
    `💰 Épargne en USDT en toute simplicité :\n` +
    `choisis un plan, dépose, et récupère tes fonds à échéance — depuis Telegram ou le site web, au choix.\n\n` +
    `👇 Que veux-tu faire ?`;

  const buttons: InlineButton[][] = [
    [
      { text: "📋 Voir les plans", callback_data: "list_plans" },
      { text: "💰 Mes dépôts", callback_data: "my_deposits" },
    ],
    [
      { text: "⚙️ Paramètres", callback_data: "settings" },
      { text: "❓ Aide", callback_data: "help" },
    ],
    [{ text: "📞 Contacter un administrateur", callback_data: "contact_admin" }],
  ];

  if (env.TELEGRAM_GROUP_LINK) {
    buttons.push([{ text: "💬 Groupe de discussion", url: env.TELEGRAM_GROUP_LINK }]);
  }

  if (env.WELCOME_IMAGE_URL) {
    await sendPhoto(env.TELEGRAM_BOT_TOKEN, chatId, env.WELCOME_IMAGE_URL, welcomeText, buttons);
  } else {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, welcomeText, buttons);
  }
}

export async function handleSettings(env: Env, chatId: number, from: any) {
  const user = await getOrCreateUser(env, from.id, from.username, from.first_name);
  const current = user.withdrawal_address ? `<code>${user.withdrawal_address}</code>` : "❌ Non définie";

  await sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    `⚙️ <b>Paramètres</b>\n\nAdresse de retrait actuelle (réseau TRC20) :\n${current}`,
    [
      [{ text: "✏️ Modifier mon adresse de retrait", callback_data: "edit_withdrawal_address" }],
      [{ text: "🏠 Retour au menu", callback_data: "start" }],
    ]
  );
}

export async function handleEditWithdrawalAddressRequest(env: Env, chatId: number, from: any) {
  const user = await getOrCreateUser(env, from.id, from.username, from.first_name);
  await setConversationState(env, user.id, "awaiting_withdrawal_address");
  await sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    "Envoie-moi ta nouvelle adresse TRON (réseau TRC20) de retrait.\n\n⚠️ Vérifie-la bien : tout envoi vers une mauvaise adresse est irréversible."
  );
}

export async function handleWithdrawalAddressText(env: Env, chatId: number, from: any, text: string) {
  const user = await getOrCreateUser(env, from.id, from.username, from.first_name);
  const result = await updateWithdrawalAddress(env, user.id, text);

  if (!result.ok) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `❌ ${result.error} Réessaie.`);
    return;
  }

  await clearConversationState(env, user.id);
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `✅ Adresse de retrait enregistrée :\n<code>${text.trim()}</code>`);
}

export async function handleListPlans(env: Env, chatId: number) {
  const plans = await listActivePlans(env);

  if (!plans.length) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Aucun plan disponible pour le moment.");
    return;
  }

  const buttons: InlineButton[][] = plans.map((p) => [
    { text: `✅ Choisir "${p.name}"`, callback_data: `choose_plan_${p.id}` },
  ]);
  buttons.push([{ text: "🏠 Retour au menu", callback_data: "start" }]);

  const text = "📋 <b>Nos plans disponibles</b>\n\n" + plans.map(formatPlanLine).join("\n\n");
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, text, buttons);
}

export async function handleChoosePlan(env: Env, chatId: number, from: any, planId: number) {
  const user = await getOrCreateUser(env, from.id, from.username, from.first_name);
  const result = await choosePlan(env, user.id, planId);

  if (!result.ok) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `⚠️ ${result.error}`);
    return;
  }

  const { plan, depositAddress } = result;
  const amountText =
    plan.amount_type === "fixed"
      ? `exactement ${plan.amount_fixed} USDT`
      : `entre ${plan.amount_min} et ${plan.amount_max} USDT`;

  await sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    `✅ Plan "<b>${plan.name}</b>" sélectionné.\n\n` +
      `Envoie ${amountText} (réseau <b>TRC20</b> uniquement) à cette adresse :\n\n` +
      `<code>${depositAddress}</code>\n\n` +
      `⏳ Le compte à rebours démarre dès que le dépôt est confirmé sur la blockchain (quelques minutes).`
  );
}

export async function handleMyDeposits(env: Env, chatId: number, from: any) {
  const user = await getOrCreateUser(env, from.id, from.username, from.first_name);
  const deposits = await listUserDeposits(env, user.id);

  if (!deposits.length) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Tu n'as encore aucun dépôt.", [
      [{ text: "📋 Voir les plans", callback_data: "list_plans" }],
    ]);
    return;
  }

  const statusLabel: Record<string, string> = {
    awaiting_deposit: "⏳ En attente de dépôt",
    confirmed: "✅ Confirmé (en cours)",
    matured: "🎉 Prêt à ramasser",
    withdrawal_pending: "🔄 Retrait en cours",
    withdrawal_approved: "🔄 Retrait approuvé",
    withdrawn: "💸 Retiré",
    rejected: "❌ Refusé",
    mismatched_amount: "⚠️ Montant à régulariser",
    refunded: "↩️ Remboursé",
  };

  const lines = deposits.map((d) => {
    const maturity = d.maturity_date ? ` — échéance : ${d.maturity_date}` : "";
    return `▸ <b>${d.plan_name}</b>\n   ${statusLabel[d.status] ?? d.status}${maturity}`;
  });

  const buttons: InlineButton[][] = deposits
    .filter((d) => d.status === "matured")
    .map((d) => [{ text: `💸 Retirer (dépôt #${d.id})`, callback_data: `withdraw_${d.id}` }]);
  buttons.push([{ text: "🏠 Retour au menu", callback_data: "start" }]);

  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "💰 <b>Mes dépôts</b>\n\n" + lines.join("\n\n"), buttons);
}

export async function handleWithdrawRequest(env: Env, chatId: number, from: any, depositId: number) {
  const user = await getOrCreateUser(env, from.id, from.username, from.first_name);
  const result = await requestWithdrawal(env, user, depositId);

  if (!result.ok) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `⚠️ ${result.error}`);
    return;
  }

  await sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    result.requiresApproval
      ? `🔄 Demande de retrait de ${result.totalAmount.toFixed(2)} USDT vers <code>${user.withdrawal_address}</code> enregistrée. Elle nécessite une validation manuelle et sera traitée sous peu.`
      : `🔄 Demande de retrait de ${result.totalAmount.toFixed(2)} USDT vers <code>${user.withdrawal_address}</code> enregistrée. Elle sera traitée automatiquement d'ici ~${result.holdMinutes} minutes.`
  );
}

export async function handleContactAdminRequest(env: Env, chatId: number, from: any) {
  const user = await getOrCreateUser(env, from.id, from.username, from.first_name);
  await setConversationState(env, user.id, "awaiting_admin_message");
  await sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    "📞 <b>Contacter un administrateur</b>\n\nÉcris ton message ci-dessous, il sera transmis directement à l'équipe. Tu recevras la réponse ici même, dans cette conversation.",
    [[{ text: "🏠 Annuler", callback_data: "start" }]]
  );
}

export async function handleAdminMessageText(env: Env, chatId: number, from: any, text: string) {
  const user = await getOrCreateUser(env, from.id, from.username, from.first_name);
  await clearConversationState(env, user.id);

  const adminChatIds = (env.ADMIN_TELEGRAM_CHAT_ID ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n));

  if (!adminChatIds.length) {
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "⚠️ Aucun administrateur n'est configuré pour le moment. Réessaie plus tard."
    );
    return;
  }

  const who = from.username ? `@${from.username}` : from.first_name ?? String(from.id);

  for (const adminChatId of adminChatIds) {
    const result: any = await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      adminChatId,
      `📩 <b>Message de ${who}</b> (ID: <code>${from.id}</code>)\n\n${text}\n\n<i>Réponds directement à ce message (reply) pour lui répondre.</i>`
    );
    const adminMessageId = result?.result?.message_id;
    if (adminMessageId) {
      await env.DB.prepare(
        `INSERT INTO support_messages (user_id, user_chat_id, admin_chat_id, admin_message_id, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      )
        .bind(user.id, chatId, adminChatId, adminMessageId)
        .run();
    }
  }

  await sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    "✅ Message envoyé à l'équipe. Tu recevras la réponse ici même dès qu'un administrateur t'aura répondu."
  );
}
