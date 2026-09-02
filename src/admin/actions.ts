// Actions admin partagées entre l'API web (/admin/api/*) et l'espace admin
// dans Telegram. Un seul endroit pour la logique métier, deux façons d'y accéder.

import { sendTrc20 } from "../tron/trongrid";
import { decryptSecret } from "../utils/crypto";
import { sendMessage } from "../bot/telegram";

export interface AdminEnv {
  DB: D1Database;
  WALLET_ENCRYPTION_KEY: string;
  TRONGRID_API_URL: string;
  TRONGRID_API_KEY?: string;
  USDT_TRC20_CONTRACT: string;
  TELEGRAM_BOT_TOKEN: string;
}

export async function logAudit(env: AdminEnv, action: string, details: Record<string, any>, source = "web") {
  await env.DB.prepare("INSERT INTO admin_audit_log (action, details) VALUES (?, ?)")
    .bind(action, JSON.stringify({ ...details, source }))
    .run();
}

export async function approveWithdrawal(env: AdminEnv, id: string | number, source = "web") {
  await env.DB.prepare("UPDATE withdrawal_requests SET status = 'approved' WHERE id = ?").bind(id).run();
  await logAudit(env, "withdrawal_approved", { withdrawal_id: id }, source);
}

export async function rejectWithdrawal(env: AdminEnv, id: string | number, source = "web") {
  await env.DB.prepare(
    "UPDATE withdrawal_requests SET status = 'rejected', resolved_at = datetime('now') WHERE id = ?"
  )
    .bind(id)
    .run();
  await logAudit(env, "withdrawal_rejected", { withdrawal_id: id }, source);
}

export async function regularizeDeposit(env: AdminEnv, depositId: string | number, source = "web") {
  const deposit = await env.DB.prepare(
    `SELECT d.*, p.duration_days FROM deposits d JOIN plans p ON p.id = d.plan_id WHERE d.id = ? AND d.status = 'mismatched_amount'`
  )
    .bind(depositId)
    .first<any>();
  if (!deposit) return { ok: false as const, error: "Dépôt introuvable ou pas en attente de régularisation" };

  const maturityDate = new Date();
  maturityDate.setDate(maturityDate.getDate() + deposit.duration_days);

  await env.DB.prepare(
    `UPDATE deposits SET status = 'confirmed', confirmed_at = datetime('now'), maturity_date = ? WHERE id = ?`
  )
    .bind(maturityDate.toISOString(), depositId)
    .run();

  await logAudit(env, "deposit_regularized", { deposit_id: depositId, amount: deposit.amount_received }, source);
  return { ok: true as const };
}

export async function refundDeposit(
  env: AdminEnv,
  depositId: string | number,
  destinationAddress: string,
  source = "web"
) {
  const deposit = await env.DB.prepare(
    `SELECT d.*, a.tron_address, a.encrypted_private_key
     FROM deposits d JOIN deposit_addresses a ON a.id = d.address_id
     WHERE d.id = ? AND d.status = 'mismatched_amount'`
  )
    .bind(depositId)
    .first<any>();
  if (!deposit) return { ok: false as const, error: "Dépôt introuvable ou pas en attente de régularisation" };

  try {
    const privateKey = await decryptSecret(deposit.encrypted_private_key, env.WALLET_ENCRYPTION_KEY);
    const amountRaw = BigInt(Math.round(deposit.amount_received * 1_000_000));
    const { txHash } = await sendTrc20(env, deposit.tron_address, privateKey, destinationAddress, amountRaw);

    await env.DB.prepare("UPDATE deposits SET status = 'refunded', refund_tx_hash = ? WHERE id = ?")
      .bind(txHash, depositId)
      .run();
    await logAudit(env, "deposit_refunded", { deposit_id: depositId, destination: destinationAddress, txHash }, source);
    return { ok: true as const, txHash };
  } catch (err: any) {
    return { ok: false as const, error: `Échec du remboursement : ${err.message}` };
  }
}

export async function blockUser(env: AdminEnv, userId: string | number, source = "web") {
  await env.DB.prepare("UPDATE users SET withdrawals_blocked = 1 WHERE id = ?").bind(userId).run();
  await logAudit(env, "user_blocked", { user_id: userId }, source);
}

export async function unblockUser(env: AdminEnv, userId: string | number, source = "web") {
  await env.DB.prepare("UPDATE users SET withdrawals_blocked = 0 WHERE id = ?").bind(userId).run();
  await logAudit(env, "user_unblocked", { user_id: userId }, source);
}

// Trouve un utilisateur par @pseudo (sans le @) ou par ID Telegram numérique
export async function findUser(env: AdminEnv, query: string) {
  const clean = query.trim().replace(/^@/, "");
  if (/^\d+$/.test(clean)) {
    return env.DB.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(Number(clean)).first<any>();
  }
  return env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(clean).first<any>();
}

export async function broadcastMessage(
  env: AdminEnv,
  ctx: ExecutionContext,
  message: string,
  source = "web"
): Promise<number> {
  const users = await env.DB.prepare("SELECT telegram_id FROM users").all<any>();
  const total = users.results?.length ?? 0;

  ctx.waitUntil(
    (async () => {
      for (const u of users.results ?? []) {
        try {
          await sendMessage(env.TELEGRAM_BOT_TOKEN, u.telegram_id, `📢 <b>Annonce</b>\n\n${message}`);
        } catch (err) {
          console.error(`Échec envoi annonce à ${u.telegram_id}:`, err);
        }
      }
    })()
  );

  await logAudit(env, "broadcast_sent", { recipient_count: total, preview: message.slice(0, 100) }, source);
  return total;
}

export async function getOverviewStats(env: AdminEnv) {
  const [activePlans, matured, mismatched, pending] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as n FROM plans WHERE active = 1").first<any>(),
    env.DB.prepare(
      `SELECT COUNT(*) as n FROM deposits WHERE status IN ('matured', 'withdrawal_pending', 'withdrawal_approved', 'withdrawn')`
    ).first<any>(),
    env.DB.prepare("SELECT COUNT(*) as n FROM deposits WHERE status = 'mismatched_amount'").first<any>(),
    env.DB.prepare(
      "SELECT COUNT(*) as n FROM withdrawal_requests WHERE status = 'pending' AND requires_admin_approval = 1"
    ).first<any>(),
  ]);
  return {
    activePlans: activePlans?.n ?? 0,
    matured: matured?.n ?? 0,
    mismatched: mismatched?.n ?? 0,
    pendingWithdrawals: pending?.n ?? 0,
  };
}
