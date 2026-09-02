// API du site web pour les utilisateurs (pas l'admin — voir admin/api.ts).
// Authentification via le widget "Login with Telegram" + jeton de session
// signé (Authorization: Bearer <token>). Toute la logique métier vit dans
// ../user/actions.ts, partagée à l'identique avec le bot Telegram.

import { UserEnv, getOrCreateUser, getUserById, listActivePlans, choosePlan, listUserDeposits, requestWithdrawal, updateWithdrawalAddress } from "../user/actions";
import { createSessionToken, verifySessionToken, verifyTelegramLoginPayload } from "../utils/session";

interface Env extends UserEnv {
  SESSION_SECRET: string;
  SITE_ORIGIN?: string;
}

function corsHeaders(env: Env) {
  return {
    "Access-Control-Allow-Origin": env.SITE_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  };
}

function json(env: Env, data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

async function getAuthedUser(request: Request, env: Env) {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const payload = await verifySessionToken(token, env.SESSION_SECRET);
  if (!payload) return null;
  const user = await getOrCreateUser(env, payload.telegramId);
  return user;
}

export async function handleWebApi(request: Request, env: Env, path: string): Promise<Response> {
  // --- Connexion via le widget "Login with Telegram" ---
  if (path === "/api/auth/telegram" && request.method === "POST") {
    const data = await request.json<Record<string, string>>();
    const valid = await verifyTelegramLoginPayload(data, env.TELEGRAM_BOT_TOKEN);
    if (!valid) return json(env, { error: "Authentification Telegram invalide." }, 401);

    const telegramId = Number(data.id);
    const user = await getOrCreateUser(env, telegramId, data.username, data.first_name);
    const token = await createSessionToken(telegramId, env.SESSION_SECRET);

    return json(env, {
      token,
      user: {
        telegramId: user.telegram_id,
        username: user.username,
        firstName: user.first_name,
        withdrawalAddress: user.withdrawal_address,
      },
    });
  }

  // --- Plans actifs : consultables sans être connecté ---
  if (path === "/api/plans" && request.method === "GET") {
    const plans = await listActivePlans(env);
    return json(env, plans);
  }

  // --- Tout ce qui suit nécessite une session valide ---
  const user = await getAuthedUser(request, env);
  if (!user) return json(env, { error: "Non authentifié. Connecte-toi avec Telegram." }, 401);

  if (path === "/api/me" && request.method === "GET") {
    return json(env, {
      telegramId: user.telegram_id,
      username: user.username,
      firstName: user.first_name,
      withdrawalAddress: user.withdrawal_address,
    });
  }

  if (path === "/api/settings" && request.method === "PUT") {
    const body = await request.json<any>();
    if (!body.withdrawalAddress) return json(env, { error: "withdrawalAddress requis" }, 400);
    const result = await updateWithdrawalAddress(env, user.id, body.withdrawalAddress);
    return result.ok ? json(env, { success: true }) : json(env, { error: result.error }, 400);
  }

  if (path === "/api/deposits" && request.method === "GET") {
    const deposits = await listUserDeposits(env, user.id);
    return json(env, deposits);
  }

  if (path === "/api/deposits" && request.method === "POST") {
    const body = await request.json<any>();
    if (!body.planId) return json(env, { error: "planId requis" }, 400);
    const result = await choosePlan(env, user.id, Number(body.planId));
    return result.ok
      ? json(env, { plan: result.plan, depositAddress: result.depositAddress })
      : json(env, { error: result.error }, 400);
  }

  if (path === "/api/withdrawals" && request.method === "POST") {
    const body = await request.json<any>();
    if (!body.depositId) return json(env, { error: "depositId requis" }, 400);
    // Recharge l'utilisateur pour avoir withdrawals_blocked et withdrawal_address à jour
    const freshUser = await getUserById(env, user.id);
    const result = await requestWithdrawal(env, freshUser, Number(body.depositId));
    return result.ok
      ? json(env, { totalAmount: result.totalAmount, requiresApproval: result.requiresApproval, holdMinutes: result.holdMinutes })
      : json(env, { error: result.error }, 400);
  }

  return json(env, { error: "Route non trouvée" }, 404);
}

export function webApiCorsResponse(env: Env) {
  return new Response(null, { headers: corsHeaders(env) });
}
