// Actions utilisateur partagées entre le bot Telegram et le site web. Le bot
// et le site appellent ces mêmes fonctions, qui lisent/écrivent dans la même
// base D1 — donc un dépôt ou un retrait fait sur l'un apparaît immédiatement
// sur l'autre. Aucune logique métier ne doit être dupliquée en dehors d'ici.

import { generateTronWallet } from "../tron/wallet";
import { encryptSecret } from "../utils/crypto";
import { sendMessage } from "../bot/telegram";

export interface UserEnv {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  WALLET_ENCRYPTION_KEY: string;
  WITHDRAWAL_AUTO_THRESHOLD_USDT: string;
  WITHDRAWAL_HOLD_MINUTES?: string;
  ADMIN_TELEGRAM_CHAT_ID?: string;
}

export function isValidTronAddress(address: string): boolean {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address.trim());
}

export async function getOrCreateUser(env: UserEnv, telegramId: number, username?: string, firstName?: string) {
  let user = await env.DB.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(telegramId).first<any>();
  if (!user) {
    await env.DB.prepare("INSERT INTO users (telegram_id, username, first_name) VALUES (?, ?, ?)")
      .bind(telegramId, username ?? null, firstName ?? null)
      .run();
    user = await env.DB.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(telegramId).first<any>();
  } else if (username && username !== user.username) {
    // Garde le pseudo à jour (utile si l'utilisateur se connecte via le site avec un pseudo changé)
    await env.DB.prepare("UPDATE users SET username = ? WHERE id = ?").bind(username, user.id).run();
    user.username = username;
  }
  return user;
}

export async function getUserById(env: UserEnv, userId: number) {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<any>();
}

export async function listActivePlans(env: UserEnv) {
  const plans = await env.DB.prepare("SELECT * FROM plans WHERE active = 1 ORDER BY duration_days").all<any>();
  return plans.results ?? [];
}

const MAX_AWAITING_PER_USER = 3;

export async function choosePlan(env: UserEnv, userId: number, planId: number) {
  const awaitingCount = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM deposits WHERE user_id = ? AND status = 'awaiting_deposit'"
  )
    .bind(userId)
    .first<any>();

  if ((awaitingCount?.count ?? 0) >= MAX_AWAITING_PER_USER) {
    return {
      ok: false as const,
      error: `Tu as déjà ${MAX_AWAITING_PER_USER} adresses en attente de dépôt. Termine ou attends la confirmation de l'une d'elles avant d'en créer une nouvelle.`,
    };
  }

  const plan = await env.DB.prepare("SELECT * FROM plans WHERE id = ? AND active = 1").bind(planId).first<any>();
  if (!plan) return { ok: false as const, error: "Ce plan n'est plus disponible." };

  const wallet = await generateTronWallet();
  const encryptedKey = await encryptSecret(wallet.privateKeyHex, env.WALLET_ENCRYPTION_KEY);

  await env.DB.prepare("INSERT INTO deposit_addresses (user_id, tron_address, encrypted_private_key) VALUES (?, ?, ?)")
    .bind(userId, wallet.address, encryptedKey)
    .run();

  const address = await env.DB.prepare("SELECT * FROM deposit_addresses WHERE tron_address = ?")
    .bind(wallet.address)
    .first<any>();

  await env.DB.prepare(
    `INSERT INTO deposits (user_id, plan_id, address_id, amount_expected, status)
     VALUES (?, ?, ?, ?, 'awaiting_deposit')`
  )
    .bind(userId, plan.id, address.id, plan.amount_type === "fixed" ? plan.amount_fixed : null)
    .run();

  return { ok: true as const, plan, depositAddress: wallet.address };
}

export async function listUserDeposits(env: UserEnv, userId: number) {
  const deposits = await env.DB.prepare(
    `SELECT d.*, p.name as plan_name, p.gain_percent
     FROM deposits d JOIN plans p ON p.id = d.plan_id
     WHERE d.user_id = ? ORDER BY d.created_at DESC LIMIT 20`
  )
    .bind(userId)
    .all<any>();
  return deposits.results ?? [];
}

export async function requestWithdrawal(env: UserEnv, user: any, depositId: number) {
  if (!user.withdrawal_address) {
    return { ok: false as const, error: "Aucune adresse de retrait définie. Renseigne-la d'abord dans tes paramètres." };
  }

  const deposit = await env.DB.prepare(
    `SELECT d.*, p.gain_percent
     FROM deposits d JOIN plans p ON p.id = d.plan_id
     WHERE d.id = ? AND d.user_id = ? AND d.status = 'matured'`
  )
    .bind(depositId, user.id)
    .first<any>();

  if (!deposit) return { ok: false as const, error: "Dépôt introuvable ou pas encore prêt." };

  const totalAmount = deposit.amount_received * (1 + deposit.gain_percent / 100);
  const rawThreshold = env.WITHDRAWAL_AUTO_THRESHOLD_USDT?.trim();
  const threshold = rawThreshold ? Number(rawThreshold) : Infinity;
  const requiresApproval = user.withdrawals_blocked || totalAmount > threshold ? 1 : 0;

  const holdMinutes = Number(env.WITHDRAWAL_HOLD_MINUTES?.trim() || "0");
  const eligibleAt = new Date(Date.now() + holdMinutes * 60_000).toISOString();

  await env.DB.prepare(
    `INSERT INTO withdrawal_requests (deposit_id, amount, destination_address, requires_admin_approval, status, eligible_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      deposit.id,
      totalAmount,
      user.withdrawal_address,
      requiresApproval,
      requiresApproval ? "pending" : "approved",
      requiresApproval ? null : eligibleAt
    )
    .run();

  await env.DB.prepare("UPDATE deposits SET status = 'withdrawal_pending' WHERE id = ?").bind(deposit.id).run();

  if (env.ADMIN_TELEGRAM_CHAT_ID) {
    const label = requiresApproval ? "à valider" : `envoyé dans ~${holdMinutes} min (bloque-le si besoin)`;
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      Number(env.ADMIN_TELEGRAM_CHAT_ID.split(",")[0]),
      `🔔 Retrait ${label} : ${totalAmount.toFixed(2)} USDT vers <code>${user.withdrawal_address}</code> (utilisateur ${user.username ?? user.telegram_id}, dépôt #${deposit.id}).`
    );
    await env.DB.prepare("UPDATE withdrawal_requests SET notified_admin_at = datetime('now') WHERE deposit_id = ?")
      .bind(deposit.id)
      .run();
  }

  return { ok: true as const, totalAmount, requiresApproval: !!requiresApproval, holdMinutes };
}

export async function updateWithdrawalAddress(env: UserEnv, userId: number, address: string) {
  const clean = address.trim();
  if (!isValidTronAddress(clean)) {
    return {
      ok: false as const,
      error: "Cette adresse ne ressemble pas à une adresse TRON valide (elle doit commencer par 'T' et faire 34 caractères).",
    };
  }
  await env.DB.prepare("UPDATE users SET withdrawal_address = ? WHERE id = ?").bind(clean, userId).run();
  return { ok: true as const };
}
