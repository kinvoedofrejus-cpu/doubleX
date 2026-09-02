// API REST simple pour l'espace administrateur.
// Authentification : header "Authorization: Bearer <ADMIN_API_KEY>"
// La logique métier vit dans ./actions.ts, partagée avec l'espace admin Telegram.

import {
  AdminEnv,
  logAudit,
  approveWithdrawal,
  rejectWithdrawal,
  regularizeDeposit,
  refundDeposit,
  blockUser,
  unblockUser,
  broadcastMessage,
} from "./actions";

interface Env extends AdminEnv {
  ADMIN_API_KEY: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

function unauthorized() {
  return new Response(JSON.stringify({ error: "Non autorisé" }), {
    status: 401,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function checkAuth(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization") ?? "";
  return auth === `Bearer ${env.ADMIN_API_KEY}`;
}

// Lit ?limit= et ?offset= avec des bornes raisonnables par défaut
function pagination(url: URL) {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50") || 50, 200);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? "0") || 0, 0);
  return { limit, offset };
}

export async function handleAdminApi(
  request: Request,
  env: Env,
  path: string,
  ctx: ExecutionContext
): Promise<Response> {
  if (!checkAuth(request, env)) return unauthorized();
  const url = new URL(request.url);

  // --- Gestion des plans ---
  if (path === "/admin/api/plans" && request.method === "GET") {
    const plans = await env.DB.prepare("SELECT * FROM plans ORDER BY created_at DESC").all();
    return json(plans.results);
  }

  if (path === "/admin/api/plans" && request.method === "POST") {
    const body = await request.json<any>();
    const { name, description, amount_type, amount_fixed, amount_min, amount_max, duration_days, gain_percent } = body;

    if (!name || !amount_type || !duration_days) {
      return json({ error: "Champs requis manquants (name, amount_type, duration_days)" }, 400);
    }

    await env.DB.prepare(
      `INSERT INTO plans (name, description, amount_type, amount_fixed, amount_min, amount_max, duration_days, gain_percent, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
      .bind(
        name,
        description ?? null,
        amount_type,
        amount_fixed ?? null,
        amount_min ?? null,
        amount_max ?? null,
        duration_days,
        gain_percent ?? 0
      )
      .run();

    await logAudit(env, "plan_created", { name, amount_type, duration_days, gain_percent });
    return json({ success: true });
  }

  const planIdMatch = path.match(/^\/admin\/api\/plans\/(\d+)$/);
  if (planIdMatch && request.method === "PUT") {
    const id = planIdMatch[1];
    const body = await request.json<any>();
    const fields = ["name", "description", "amount_type", "amount_fixed", "amount_min", "amount_max", "duration_days", "gain_percent", "active"];
    const updates = fields.filter((f) => f in body);
    if (!updates.length) return json({ error: "Rien à mettre à jour" }, 400);

    const setClause = updates.map((f) => `${f} = ?`).join(", ") + ", updated_at = datetime('now')";
    const values = updates.map((f) => body[f]);
    await env.DB.prepare(`UPDATE plans SET ${setClause} WHERE id = ?`)
      .bind(...values, id)
      .run();

    await logAudit(env, "plan_updated", { plan_id: id, fields: updates });
    return json({ success: true });
  }

  if (planIdMatch && request.method === "DELETE") {
    await env.DB.prepare("UPDATE plans SET active = 0 WHERE id = ?").bind(planIdMatch[1]).run();
    await logAudit(env, "plan_deactivated", { plan_id: planIdMatch[1] });
    return json({ success: true });
  }

  // --- Comptes arrivés à terme ---
  if (path === "/admin/api/deposits/matured" && request.method === "GET") {
    const { limit, offset } = pagination(url);
    const matured = await env.DB.prepare(
      `SELECT d.id as deposit_id, d.status, d.amount_received, d.maturity_date, d.swept_at,
              p.name as plan_name, p.gain_percent,
              u.telegram_id, u.username, u.first_name, u.withdrawal_address,
              w.amount as withdrawal_amount, w.status as withdrawal_status, w.requires_admin_approval, w.tx_hash
       FROM deposits d
       JOIN plans p ON p.id = d.plan_id
       JOIN users u ON u.id = d.user_id
       LEFT JOIN withdrawal_requests w ON w.deposit_id = d.id
       WHERE d.status IN ('matured', 'withdrawal_pending', 'withdrawal_approved', 'withdrawn')
       ORDER BY d.maturity_date ASC LIMIT ? OFFSET ?`
    )
      .bind(limit, offset)
      .all();
    const total = await env.DB.prepare(
      `SELECT COUNT(*) as n FROM deposits WHERE status IN ('matured', 'withdrawal_pending', 'withdrawal_approved', 'withdrawn')`
    ).first<any>();
    return json({ results: matured.results, limit, offset, total: total?.n ?? 0 });
  }

  // --- Dépôts avec montant hors plan ---
  if (path === "/admin/api/deposits/mismatched" && request.method === "GET") {
    const mismatched = await env.DB.prepare(
      `SELECT d.*, u.telegram_id, u.username, p.name as plan_name, a.tron_address
       FROM deposits d
       JOIN users u ON u.id = d.user_id
       JOIN plans p ON p.id = d.plan_id
       JOIN deposit_addresses a ON a.id = d.address_id
       WHERE d.status = 'mismatched_amount'
       ORDER BY d.created_at ASC`
    ).all();
    return json(mismatched.results);
  }

  const regularizeMatch = path.match(/^\/admin\/api\/deposits\/(\d+)\/regularize$/);
  if (regularizeMatch && request.method === "POST") {
    const result = await regularizeDeposit(env, regularizeMatch[1]);
    return result.ok ? json({ success: true }) : json({ error: result.error }, 404);
  }

  const refundMatch = path.match(/^\/admin\/api\/deposits\/(\d+)\/refund$/);
  if (refundMatch && request.method === "POST") {
    const body = await request.json<any>();
    if (!body.destination_address) return json({ error: "destination_address requis" }, 400);
    const result = await refundDeposit(env, refundMatch[1], body.destination_address);
    return result.ok ? json({ success: true, txHash: result.txHash }) : json({ error: result.error }, result.error?.includes("introuvable") ? 404 : 500);
  }

  // --- Suivi des dépôts ---
  if (path === "/admin/api/deposits" && request.method === "GET") {
    const { limit, offset } = pagination(url);
    const deposits = await env.DB.prepare(
      `SELECT d.*, u.telegram_id, u.username, p.name as plan_name, a.tron_address
       FROM deposits d
       JOIN users u ON u.id = d.user_id
       JOIN plans p ON p.id = d.plan_id
       JOIN deposit_addresses a ON a.id = d.address_id
       ORDER BY d.created_at DESC LIMIT ? OFFSET ?`
    )
      .bind(limit, offset)
      .all();
    return json({ results: deposits.results, limit, offset });
  }

  // --- Retraits en attente de validation admin ---
  if (path === "/admin/api/withdrawals/pending" && request.method === "GET") {
    const { limit, offset } = pagination(url);
    const pending = await env.DB.prepare(
      `SELECT w.*, d.user_id, u.telegram_id, u.username, u.first_name
       FROM withdrawal_requests w
       JOIN deposits d ON d.id = w.deposit_id
       JOIN users u ON u.id = d.user_id
       WHERE w.status = 'pending' AND w.requires_admin_approval = 1
       ORDER BY w.created_at ASC LIMIT ? OFFSET ?`
    )
      .bind(limit, offset)
      .all();
    const total = await env.DB.prepare(
      `SELECT COUNT(*) as n FROM withdrawal_requests WHERE status = 'pending' AND requires_admin_approval = 1`
    ).first<any>();
    return json({ results: pending.results, limit, offset, total: total?.n ?? 0 });
  }

  // --- Retraits approuvés mais pas encore envoyés (si une fenêtre de délai est configurée) ---
  if (path === "/admin/api/withdrawals/upcoming" && request.method === "GET") {
    const { limit, offset } = pagination(url);
    const upcoming = await env.DB.prepare(
      `SELECT w.*, d.user_id, u.telegram_id, u.username, u.first_name
       FROM withdrawal_requests w
       JOIN deposits d ON d.id = w.deposit_id
       JOIN users u ON u.id = d.user_id
       WHERE w.status = 'approved'
       ORDER BY w.eligible_at ASC LIMIT ? OFFSET ?`
    )
      .bind(limit, offset)
      .all();
    return json({ results: upcoming.results, limit, offset });
  }

  const approveMatch = path.match(/^\/admin\/api\/withdrawals\/(\d+)\/approve$/);
  if (approveMatch && request.method === "POST") {
    await approveWithdrawal(env, approveMatch[1]);
    return json({ success: true, note: "Sera envoyé automatiquement au prochain passage du cron." });
  }

  const rejectMatch = path.match(/^\/admin\/api\/withdrawals\/(\d+)\/reject$/);
  if (rejectMatch && request.method === "POST") {
    await rejectWithdrawal(env, rejectMatch[1]);
    return json({ success: true });
  }

  // --- Annonce diffusée à tous les utilisateurs du bot ---
  if (path === "/admin/api/broadcast" && request.method === "POST") {
    const body = await request.json<any>();
    if (!body.message || typeof body.message !== "string") {
      return json({ error: "Champ 'message' requis" }, 400);
    }
    const total = await broadcastMessage(env, ctx, body.message);
    return json({ success: true, recipient_count: total, note: "Envoi en cours en arrière-plan." });
  }

  // --- Recherche d'utilisateurs (par @pseudo ou ID Telegram) ---
  if (path === "/admin/api/users" && request.method === "GET") {
    const search = url.searchParams.get("search")?.trim();
    const query = "SELECT id, telegram_id, username, first_name, withdrawal_address, withdrawals_blocked, created_at FROM users";
    let results;
    if (search) {
      const like = `%${search.replace(/^@/, "")}%`;
      results = await env.DB.prepare(query + " WHERE username LIKE ? OR CAST(telegram_id AS TEXT) LIKE ? ORDER BY created_at DESC LIMIT 50")
        .bind(like, like)
        .all();
    } else {
      results = await env.DB.prepare(query + " ORDER BY created_at DESC LIMIT 50").all();
    }
    return json(results.results);
  }

  const blockUserMatch = path.match(/^\/admin\/api\/users\/(\d+)\/block$/);
  if (blockUserMatch && request.method === "POST") {
    await blockUser(env, blockUserMatch[1]);
    return json({ success: true });
  }

  const unblockUserMatch = path.match(/^\/admin\/api\/users\/(\d+)\/unblock$/);
  if (unblockUserMatch && request.method === "POST") {
    await unblockUser(env, unblockUserMatch[1]);
    return json({ success: true });
  }

  // --- Journal d'audit des actions admin ---
  if (path === "/admin/api/audit-log" && request.method === "GET") {
    const { limit, offset } = pagination(url);
    const log = await env.DB.prepare("SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .bind(limit, offset)
      .all();
    return json({ results: log.results, limit, offset });
  }

  return json({ error: "Route non trouvée" }, 404);
}
