// Petites fonctions d'appel à l'API Telegram Bot (pas de dépendance externe,
// tout passe par fetch — compatible Cloudflare Workers).

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
  buttons?: InlineButton[][]
) {
  const body: any = { chat_id: chatId, text, parse_mode: "HTML" };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error("Erreur envoi Telegram:", await res.text());
  }
  return res.json();
}

export async function answerCallbackQuery(botToken: string, callbackQueryId: string, text?: string) {
  await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

export async function sendPhoto(
  botToken: string,
  chatId: number,
  photoUrl: string,
  caption: string,
  buttons?: InlineButton[][]
) {
  const body: any = { chat_id: chatId, photo: photoUrl, caption, parse_mode: "HTML" };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error("Erreur envoi photo Telegram:", await res.text());
  }
  return res.json();
}

export async function setMyCommands(botToken: string, adminChatIds: number[] = []) {
  const commands = [
    { command: "start", description: "🏠 Menu principal" },
    { command: "plans", description: "📋 Voir les plans disponibles" },
    { command: "depots", description: "💰 Mes dépôts en cours" },
    { command: "parametres", description: "⚙️ Mon adresse de retrait" },
    { command: "contact", description: "📞 Contacter un administrateur" },
    { command: "help", description: "❓ Aide" },
  ];
  const res = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands }),
  });
  const defaultResult = await res.json();

  // Ajoute /admin uniquement dans le menu des chats admin (scope Telegram par chat),
  // invisible pour tous les autres utilisateurs.
  const adminResults = [];
  for (const chatId of adminChatIds) {
    const adminRes = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commands: [...commands, { command: "admin", description: "🛠 Espace admin" }],
        scope: { type: "chat", chat_id: chatId },
      }),
    });
    adminResults.push(await adminRes.json());
  }

  return { default: defaultResult, admin: adminResults };
}

export async function setWebhook(botToken: string, url: string, secretToken: string) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, secret_token: secretToken }),
  });
  return res.json();
}
