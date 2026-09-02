// Espace admin directement dans Telegram — réservé aux chats listés dans
// ADMIN_TELEGRAM_CHAT_ID (un ou plusieurs ID séparés par des virgules).
// Réutilise la même logique métier que le tableau de bord web (./actions.ts).

import { sendMessage, InlineButton } from "./telegram";
import {
  AdminEnv,
  getOverviewStats,
  approveWithdrawal,
  rejectWithdrawal,
  regularizeDeposit,
  refundDeposit,
  blockUser,
  findUser,
  broadcastMessage,
} from "../admin/actions";

interface Env extends AdminEnv {
  DB: D1Database;
  ADMIN_TELEGRAM_CHAT_ID?: string;
}

export function isAdminChat(env: Env, chatId: number): boolean {
  const allowed = (env.ADMIN_TELEGRAM_CHAT_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(String(chatId));
}

async function setAdminState(env: Env, chatId: number, state: string, data?: string) {
  await env.DB.prepare(
    `INSERT INTO conversation_state (user_id, state, data, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = datetime('now')`
  )
    // On réutilise la table conversation_state avec un identifiant négatif dérivé du
    // chat admin pour ne jamais entrer en collision avec un vrai user_id (positif).
    .bind(-chatId, state, data ?? null)
    .run();
}

export async function getAdminState(env: Env, chatId: number) {
  return env.DB.prepare("SELECT * FROM conversation_state WHERE user_id = ?").bind(-chatId).first<any>();
}

async function clearAdminState(env: Env, chatId: number) {
  await env.DB.prepare("DELETE FROM conversation_state WHERE user_id = ?").bind(-chatId).run();
}

export async function handleAdminMenu(env: Env, chatId: number) {
  const stats = await getOverviewStats(env);
  const text =
    `🛠 <b>Espace Admin</b>\n\n` +
    `📋 Plans actifs : <b>${stats.activePlans}</b>\n` +
    `🎉 Comptes à terme : <b>${stats.matured}</b>\n` +
    `⚠️ Montants à régulariser : <b>${stats.mismatched}</b>\n` +
    `🔴 Retraits à valider : <b>${stats.pendingWithdrawals}</b>`;

  const buttons: InlineButton[][] = [
    [
      { text: "🔴 Retraits à valider", callback_data: "adm_withdrawals" },
      { text: "⚠️ Montants erronés", callback_data: "adm_mismatched" },
    ],
    [
      { text: "🚫 Bloquer un utilisateur", callback_data: "adm_block_user" },
      { text: "📢 Annonce", callback_data: "adm_broadcast" },
    ],
    [{ text: "🔄 Rafraîchir", callback_data: "adm_menu" }],
  ];

  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, text, buttons);
}

export async function handleAdminWithdrawals(env: Env, chatId: number) {
  const pending = await env.DB.prepare(
    `SELECT w.*, u.username, u.first_name, u.telegram_id
     FROM withdrawal_requests w
     JOIN deposits d ON d.id = w.deposit_id
     JOIN users u ON u.id = d.user_id
     WHERE w.status = 'pending' AND w.requires_admin_approval = 1
     ORDER BY w.created_at ASC LIMIT 10`
  ).all<any>();

  if (!pending.results?.length) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "✅ Aucun retrait en attente de validation.", [
      [{ text: "🏠 Menu admin", callback_data: "adm_menu" }],
    ]);
    return;
  }

  for (const w of pending.results) {
    const who = w.username ? `@${w.username}` : w.first_name ?? String(w.telegram_id);
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      `🔴 Retrait #${w.id} — ${who}\n💰 ${w.amount} USDT\n📍 <code>${w.destination_address}</code>`,
      [
        [
          { text: "✅ Valider", callback_data: `adm_approve_${w.id}` },
          { text: "❌ Refuser", callback_data: `adm_reject_${w.id}` },
        ],
      ]
    );
  }
}

export async function handleAdminMismatched(env: Env, chatId: number) {
  const mismatched = await env.DB.prepare(
    `SELECT d.*, u.username, u.first_name, u.telegram_id, p.name as plan_name, a.tron_address
     FROM deposits d
     JOIN users u ON u.id = d.user_id
     JOIN plans p ON p.id = d.plan_id
     JOIN deposit_addresses a ON a.id = d.address_id
     WHERE d.status = 'mismatched_amount'
     ORDER BY d.created_at ASC LIMIT 10`
  ).all<any>();

  if (!mismatched.results?.length) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "✅ Aucun montant à régulariser.", [
      [{ text: "🏠 Menu admin", callback_data: "adm_menu" }],
    ]);
    return;
  }

  for (const d of mismatched.results) {
    const who = d.username ? `@${d.username}` : d.first_name ?? String(d.telegram_id);
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      `⚠️ Dépôt #${d.id} — ${who} — Plan "${d.plan_name}"\n💰 Reçu : ${d.amount_received} USDT\n📍 <code>${d.tron_address}</code>`,
      [
        [
          { text: "✅ Accepter tel quel", callback_data: `adm_regularize_${d.id}` },
          { text: "↩️ Rembourser", callback_data: `adm_refund_${d.id}` },
        ],
      ]
    );
  }
}

export async function handleAdminCallback(env: Env, chatId: number, data: string): Promise<boolean> {
  if (data === "adm_menu") {
    await handleAdminMenu(env, chatId);
    return true;
  }
  if (data === "adm_withdrawals") {
    await handleAdminWithdrawals(env, chatId);
    return true;
  }
  if (data === "adm_mismatched") {
    await handleAdminMismatched(env, chatId);
    return true;
  }
  if (data === "adm_block_user") {
    await setAdminState(env, chatId, "awaiting_block_user_query");
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Envoie le @pseudo ou l'ID Telegram de l'utilisateur à bloquer.");
    return true;
  }
  if (data === "adm_broadcast") {
    await setAdminState(env, chatId, "awaiting_broadcast_message");
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Envoie le texte de l'annonce à diffuser à tous les utilisateurs.");
    return true;
  }
  if (data.startsWith("adm_approve_")) {
    const id = data.replace("adm_approve_", "");
    await approveWithdrawal(env, id, "telegram");
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `✅ Retrait #${id} validé — sera envoyé au prochain passage du cron.`);
    return true;
  }
  if (data.startsWith("adm_reject_")) {
    const id = data.replace("adm_reject_", "");
    await rejectWithdrawal(env, id, "telegram");
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `❌ Retrait #${id} refusé.`);
    return true;
  }
  if (data.startsWith("adm_regularize_")) {
    const id = data.replace("adm_regularize_", "");
    const result = await regularizeDeposit(env, id, "telegram");
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      result.ok ? `✅ Dépôt #${id} régularisé, reprend son cours normal.` : `❌ ${result.error}`
    );
    return true;
  }
  if (data.startsWith("adm_refund_")) {
    const id = data.replace("adm_refund_", "");
    await setAdminState(env, chatId, "awaiting_refund_address", id);
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Envoie l'adresse TRON de destination pour rembourser le dépôt #${id}.`);
    return true;
  }
  return false;
}

// Traite le message texte suivant une action qui attendait une saisie
// (bloquer un utilisateur, adresse de remboursement, texte d'annonce).
export async function handleAdminText(env: Env, ctx: ExecutionContext, chatId: number, text: string): Promise<boolean> {
  const state = await getAdminState(env, chatId);
  if (!state) return false;

  if (state.state === "awaiting_block_user_query") {
    const user = await findUser(env, text);
    if (!user) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "❌ Utilisateur introuvable. Réessaie avec @pseudo ou l'ID Telegram.");
      return true;
    }
    await blockUser(env, user.id, "telegram");
    await clearAdminState(env, chatId);
    const who = user.username ? `@${user.username}` : String(user.telegram_id);
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      `🚫 ${who} est maintenant bloqué : tous ses futurs retraits nécessiteront ta validation.`,
      [[{ text: "🏠 Menu admin", callback_data: "adm_menu" }]]
    );
    return true;
  }

  if (state.state === "awaiting_refund_address") {
    const depositId = state.data;
    const result = await refundDeposit(env, depositId, text.trim(), "telegram");
    await clearAdminState(env, chatId);
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      result.ok ? `✅ Remboursement envoyé. Tx : <code>${result.txHash}</code>` : `❌ ${result.error}`,
      [[{ text: "🏠 Menu admin", callback_data: "adm_menu" }]]
    );
    return true;
  }

  if (state.state === "awaiting_broadcast_message") {
    await clearAdminState(env, chatId);
    const count = await broadcastMessage(env, ctx, text, "telegram");
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      `📢 Annonce envoyée à ${count} utilisateur(s) (envoi en cours en arrière-plan).`,
      [[{ text: "🏠 Menu admin", callback_data: "adm_menu" }]]
    );
    return true;
  }

  return false;
}

// Quand un admin répond (reply Telegram) à un message transmis via "Contacter
// un administrateur", relaie sa réponse vers l'utilisateur d'origine.
// Retourne false si le message répondu n'est pas un message de support connu
// (laisse alors la suite du routage traiter le message normalement).
export async function handleAdminSupportReply(
  env: Env,
  adminChatId: number,
  replyToMessageId: number,
  text: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT * FROM support_messages WHERE admin_chat_id = ? AND admin_message_id = ?`
  )
    .bind(adminChatId, replyToMessageId)
    .first<any>();

  if (!row) return false;

  await sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    row.user_chat_id,
    `💬 <b>Réponse de l'administrateur :</b>\n\n${text}`
  );
  await sendMessage(env.TELEGRAM_BOT_TOKEN, adminChatId, "✅ Réponse envoyée à l'utilisateur.");
  return true;
}
