import {
  handleStart,
  handleListPlans,
  handleChoosePlan,
  handleMyDeposits,
  handleWithdrawRequest,
  handleSettings,
  handleEditWithdrawalAddressRequest,
  handleWithdrawalAddressText,
  handleHelp,
  handleContactAdminRequest,
  handleAdminMessageText,
  getConversationState,
} from "./bot/handlers";
import { answerCallbackQuery, setWebhook, setMyCommands } from "./bot/telegram";
import {
  isAdminChat,
  handleAdminMenu,
  handleAdminCallback,
  handleAdminText,
  handleAdminSupportReply,
} from "./bot/admin";
import { handleAdminApi } from "./admin/api";
import { handleWebApi, webApiCorsResponse } from "./web/api";
import { runScheduledTasks } from "./scheduled";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ADMIN_API_KEY: string;
  WALLET_ENCRYPTION_KEY: string;
  TRONGRID_API_URL: string;
  TRONGRID_API_KEY?: string;
  USDT_TRC20_CONTRACT: string;
  WITHDRAWAL_AUTO_THRESHOLD_USDT: string;
  WITHDRAWAL_HOLD_MINUTES?: string;
  CENTRAL_WALLET_ADDRESS: string;
  CENTRAL_WALLET_PRIVATE_KEY: string;
  SWEEP_GAS_TRX: string;
  TELEGRAM_GROUP_LINK?: string;
  TELEGRAM_ANNOUNCEMENT_CHANNEL_ID?: string;
  ADMIN_TELEGRAM_CHAT_ID?: string;
  WELCOME_IMAGE_URL?: string;
  SESSION_SECRET: string;
  SITE_ORIGIN?: string;
}

const TEXT_COMMANDS: Record<string, (env: Env, chatId: number, from: any) => Promise<void>> = {
  "/start": (env, chatId, from) => handleStart(env, chatId, from),
  "/plans": (env, chatId) => handleListPlans(env, chatId),
  "/depots": (env, chatId, from) => handleMyDeposits(env, chatId, from),
  "/parametres": (env, chatId, from) => handleSettings(env, chatId, from),
  "/help": (env, chatId) => handleHelp(env, chatId),
  "/contact": (env, chatId, from) => handleContactAdminRequest(env, chatId, from),
};

async function handleTelegramUpdate(update: any, env: Env, ctx: ExecutionContext) {
  const chatIdFromMessage = update.message?.chat?.id;
  const chatIdFromCallback = update.callback_query?.message?.chat?.id;
  const chatId = chatIdFromMessage ?? chatIdFromCallback;
  const isAdmin = typeof chatId === "number" && isAdminChat(env, chatId);

  // Commande admin : /admin (uniquement pour les chats autorisés)
  const command = update.message?.text?.split(" ")[0];
  if (command === "/admin") {
    if (!isAdmin) return; // silence total pour tout le monde d'autre — pas de fuite d'info
    await handleAdminMenu(env, chatId);
    return;
  }

  if (command && TEXT_COMMANDS[command]) {
    await TEXT_COMMANDS[command](env, chatId, update.message.from);
    return;
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    const data: string = cq.data;

    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, cq.id);

    // Les callbacks "adm_*" sont exclusivement réservés à l'admin
    if (data.startsWith("adm_")) {
      if (!isAdmin) return;
      await handleAdminCallback(env, chatId, data);
      return;
    }

    if (data === "start") {
      await handleStart(env, chatId, cq.from);
    } else if (data === "help") {
      await handleHelp(env, chatId);
    } else if (data === "list_plans") {
      await handleListPlans(env, chatId);
    } else if (data === "my_deposits") {
      await handleMyDeposits(env, chatId, cq.from);
    } else if (data === "settings") {
      await handleSettings(env, chatId, cq.from);
    } else if (data === "edit_withdrawal_address") {
      await handleEditWithdrawalAddressRequest(env, chatId, cq.from);
    } else if (data === "contact_admin") {
      await handleContactAdminRequest(env, chatId, cq.from);
    } else if (data.startsWith("choose_plan_")) {
      const planId = Number(data.replace("choose_plan_", ""));
      await handleChoosePlan(env, chatId, cq.from, planId);
    } else if (data.startsWith("withdraw_")) {
      const depositId = Number(data.replace("withdraw_", ""));
      await handleWithdrawRequest(env, chatId, cq.from, depositId);
    }
    return;
  }

  // Message texte simple : d'abord, si c'est un admin au milieu d'un flux
  // admin (bloquer un user, rembourser, annonce), on le traite en priorité.
  if (update.message?.text) {
    if (isAdmin) {
      // D'abord : est-ce une réponse (reply) à un message transmis via
      // "Contacter un administrateur" ? Si oui, on relaie et on s'arrête là.
      const replyToId = update.message.reply_to_message?.message_id;
      if (replyToId) {
        const relayed = await handleAdminSupportReply(env, chatId, replyToId, update.message.text);
        if (relayed) return;
      }

      const handled = await handleAdminText(env, ctx, chatId, update.message.text);
      if (handled) return;
    }

    // Sinon, flux utilisateur normal (ex: saisie de son adresse de retrait,
    // ou message destiné à l'admin)
    const telegramId = update.message.from.id;
    const user = await env.DB.prepare("SELECT * FROM users WHERE telegram_id = ?")
      .bind(telegramId)
      .first<any>();
    if (!user) return;

    const state = await getConversationState(env, user.id);
    if (state?.state === "awaiting_withdrawal_address") {
      await handleWithdrawalAddressText(env, chatId, update.message.from, update.message.text);
    } else if (state?.state === "awaiting_admin_message") {
      await handleAdminMessageText(env, chatId, update.message.from, update.message.text);
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/webhook/telegram" && request.method === "POST") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Non autorisé", { status: 401 });
      }
      const update = await request.json();
      await handleTelegramUpdate(update, env, ctx);
      return new Response("OK");
    }

    // Configure en un seul appel : le webhook Telegram ET le menu de commandes
    // persistant en bas de l'écran. À appeler une fois après chaque déploiement
    // initial (ou si tu changes de token). Protégé par ADMIN_API_KEY.
    if (url.pathname === "/setup" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (key !== env.ADMIN_API_KEY) return new Response("Non autorisé", { status: 401 });

      const webhookUrl = `${url.origin}/webhook/telegram`;
      const webhookResult = await setWebhook(env.TELEGRAM_BOT_TOKEN, webhookUrl, env.TELEGRAM_WEBHOOK_SECRET);
      const adminChatIds = (env.ADMIN_TELEGRAM_CHAT_ID ?? "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => !Number.isNaN(n));
      const commandsResult = await setMyCommands(env.TELEGRAM_BOT_TOKEN, adminChatIds);

      return new Response(JSON.stringify({ webhook: webhookResult, commands: commandsResult }, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") return webApiCorsResponse(env);
      return handleWebApi(request, env, url.pathname);
    }

    if (url.pathname.startsWith("/admin/api/")) {
      // Réponse au "preflight" CORS envoyé par le navigateur avant chaque requête
      // depuis un domaine différent (ex: ton tableau de bord sur GitHub Pages).
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
          },
        });
      }
      return handleAdminApi(request, env, url.pathname, ctx);
    }

    return new Response("Tontine Bot — Worker actif", { status: 200 });
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    await runScheduledTasks(env);
  },
};
