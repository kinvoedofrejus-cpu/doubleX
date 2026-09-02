import { getTrc20TransfersReceived, sendTrc20, sendTrx, getTrxBalance } from "./tron/trongrid";
import { decryptSecret } from "./utils/crypto";
import { sendMessage } from "./bot/telegram";
import { tronAddressToHex } from "./tron/wallet";

interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TRONGRID_API_URL: string;
  TRONGRID_API_KEY?: string;
  USDT_TRC20_CONTRACT: string;
  WALLET_ENCRYPTION_KEY: string;
  WITHDRAWAL_AUTO_THRESHOLD_USDT: string;
  // Portefeuille central : reçoit tous les fonds balayés depuis les adresses de dépôt,
  // et sert de source pour les retraits envoyés aux utilisateurs.
  CENTRAL_WALLET_ADDRESS: string;
  CENTRAL_WALLET_PRIVATE_KEY: string;
  // Quantité de TRX envoyée à chaque adresse de dépôt pour payer les frais du sweep
  SWEEP_GAS_TRX: string;
  // Chaîne Telegram sur laquelle annoncer chaque retrait effectué
  TELEGRAM_ANNOUNCEMENT_CHANNEL_ID?: string;
  // Chat Telegram (admin ou groupe privé admin) prévenu des actions nécessitant une intervention
  ADMIN_TELEGRAM_CHAT_ID?: string;
}

// 1. Vérifie les adresses en attente de dépôt et détecte les virements USDT reçus
async function checkPendingDeposits(env: Env) {
  const pending = await env.DB.prepare(
    `SELECT d.*, a.tron_address, p.duration_days, p.amount_type, p.amount_min, p.amount_max, u.telegram_id
     FROM deposits d
     JOIN deposit_addresses a ON a.id = d.address_id
     JOIN plans p ON p.id = d.plan_id
     JOIN users u ON u.id = d.user_id
     WHERE d.status = 'awaiting_deposit'`
  ).all<any>();

  for (const deposit of pending.results ?? []) {
    try {
      const since = new Date(deposit.created_at + "Z").getTime();
      const transfers = await getTrc20TransfersReceived(env, deposit.tron_address, since);
      if (!transfers.length) continue;

      const transfer = transfers[0];
      const amountReceived = Number(transfer.value) / 1_000_000; // USDT = 6 décimales

      // Vérifie que le montant respecte le plan (fixe ou plage)
      const isFixedTooLow =
        deposit.amount_type === "fixed" && deposit.amount_expected && amountReceived < deposit.amount_expected;
      const isOutOfRange =
        deposit.amount_type === "range" &&
        (amountReceived < deposit.amount_min || amountReceived > deposit.amount_max);

      if (isFixedTooLow) {
        continue; // montant insuffisant, on attend un éventuel complément (pas encore une erreur)
      }

      if (isOutOfRange) {
        // Hors plage définie par le plan : on ne devine pas quoi faire, on alerte
        // l'utilisateur et l'admin pour une régularisation manuelle (remboursement ou ajustement).
        await env.DB.prepare(
          `UPDATE deposits SET status = 'mismatched_amount', amount_received = ?, deposit_tx_hash = ? WHERE id = ?`
        )
          .bind(amountReceived, transfer.transaction_id, deposit.id)
          .run();

        await sendMessage(
          env.TELEGRAM_BOT_TOKEN,
          deposit.telegram_id,
          `⚠️ Nous avons bien reçu ${amountReceived} USDT, mais ce montant ne correspond pas à la plage autorisée par ton plan. Un administrateur va examiner ta demande — contacte le support si besoin.`
        );

        if (env.ADMIN_TELEGRAM_CHAT_ID) {
          await sendMessage(
            env.TELEGRAM_BOT_TOKEN,
            Number(env.ADMIN_TELEGRAM_CHAT_ID),
            `🚨 Montant hors plage reçu — dépôt #${deposit.id}, utilisateur ${deposit.telegram_id} : ${amountReceived} USDT (adresse ${deposit.tron_address}). À régulariser via /admin/api/deposits/:id/refund ou une action manuelle.`
          );
        }
        continue;
      }

      const maturityDate = new Date();
      maturityDate.setDate(maturityDate.getDate() + deposit.duration_days);

      await env.DB.prepare(
        `UPDATE deposits SET status = 'confirmed', amount_received = ?, deposit_tx_hash = ?,
         confirmed_at = datetime('now'), maturity_date = ? WHERE id = ?`
      )
        .bind(amountReceived, transfer.transaction_id, maturityDate.toISOString(), deposit.id)
        .run();

      await sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        deposit.telegram_id,
        `✅ Dépôt de ${amountReceived} USDT confirmé !\nDate de ramassage : ${maturityDate.toLocaleDateString("fr-FR")}`
      );
    } catch (err) {
      console.error(`Erreur vérification dépôt #${deposit.id}:`, err);
    }
  }
}

// 2. Balaye (sweep) les dépôts confirmés mais pas encore transférés vers le portefeuille central.
//    Étape 1 : envoie un peu de TRX depuis le portefeuille central vers l'adresse de dépôt (frais du sweep)
//    Étape 2 : l'adresse de dépôt transfère tout l'USDT reçu vers le portefeuille central
async function sweepConfirmedDeposits(env: Env) {
  const toSweep = await env.DB.prepare(
    `SELECT d.*, a.tron_address, a.encrypted_private_key
     FROM deposits d
     JOIN deposit_addresses a ON a.id = d.address_id
     WHERE d.status = 'confirmed' AND d.swept_at IS NULL AND d.amount_received IS NOT NULL`
  ).all<any>();

  const gasAmount = Number(env.SWEEP_GAS_TRX ?? "15");

  for (const deposit of toSweep.results ?? []) {
    try {
      const depositAddressHex = tronAddressToHex(deposit.tron_address);
      const trxBalance = await getTrxBalance(env, depositAddressHex);

      // Envoie du gas si l'adresse n'en a pas assez pour payer les frais du transfert TRC20
      if (trxBalance < gasAmount) {
        await sendTrx(
          env,
          env.CENTRAL_WALLET_ADDRESS,
          env.CENTRAL_WALLET_PRIVATE_KEY,
          deposit.tron_address,
          gasAmount - trxBalance
        );
        // Le sweep se fera au prochain passage du cron, le temps que le TRX arrive
        continue;
      }

      const privateKey = await decryptSecret(deposit.encrypted_private_key, env.WALLET_ENCRYPTION_KEY);
      const amountRaw = BigInt(Math.round(deposit.amount_received * 1_000_000));

      const { txHash } = await sendTrc20(
        env,
        deposit.tron_address,
        privateKey,
        env.CENTRAL_WALLET_ADDRESS,
        amountRaw
      );

      await env.DB.prepare("UPDATE deposits SET swept_at = datetime('now'), swept_tx_hash = ? WHERE id = ?")
        .bind(txHash, deposit.id)
        .run();
    } catch (err) {
      console.error(`Erreur sweep dépôt #${deposit.id}:`, err);
    }
  }
}

// 3. Passe en "matured" les dépôts confirmés dont l'échéance est atteinte
async function checkMaturedDeposits(env: Env) {
  const matured = await env.DB.prepare(
    `SELECT d.*, u.telegram_id FROM deposits d
     JOIN users u ON u.id = d.user_id
     WHERE d.status = 'confirmed' AND d.maturity_date <= datetime('now')`
  ).all<any>();

  for (const deposit of matured.results ?? []) {
    await env.DB.prepare("UPDATE deposits SET status = 'matured' WHERE id = ?").bind(deposit.id).run();
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      deposit.telegram_id,
      `🎉 Ton dépôt est arrivé à échéance ! Tu peux maintenant le retirer via "Mes dépôts".`
    );
  }
}

// 4. Traite les retraits approuvés (auto sous le seuil, ou validés manuellement par l'admin)
//    Les fonds partent désormais du portefeuille central (plus des adresses de dépôt individuelles),
//    puisque tout est balayé (sweep) vers ce portefeuille après confirmation du dépôt.
async function processApprovedWithdrawals(env: Env) {
  const approved = await env.DB.prepare(
    `SELECT w.*, d.address_id, u.telegram_id
     FROM withdrawal_requests w
     JOIN deposits d ON d.id = w.deposit_id
     JOIN users u ON u.id = d.user_id
     WHERE w.status = 'approved' AND (w.eligible_at IS NULL OR w.eligible_at <= datetime('now'))`
  ).all<any>();

  for (const wr of approved.results ?? []) {
    try {
      const amountRaw = BigInt(Math.round(wr.amount * 1_000_000));
      const { txHash } = await sendTrc20(
        env,
        env.CENTRAL_WALLET_ADDRESS,
        env.CENTRAL_WALLET_PRIVATE_KEY,
        wr.destination_address,
        amountRaw
      );

      await env.DB.prepare(
        "UPDATE withdrawal_requests SET status = 'sent', tx_hash = ?, resolved_at = datetime('now') WHERE id = ?"
      )
        .bind(txHash, wr.id)
        .run();
      await env.DB.prepare("UPDATE deposits SET status = 'withdrawn' WHERE id = ?").bind(wr.deposit_id).run();

      await sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        wr.telegram_id,
        `💸 Retrait envoyé ! ${wr.amount} USDT vers ${wr.destination_address}\nTx : ${txHash}`
      );

      if (env.TELEGRAM_ANNOUNCEMENT_CHANNEL_ID) {
        const shortAddress = `${wr.destination_address.slice(0, 6)}…${wr.destination_address.slice(-4)}`;
        await sendMessage(
          env.TELEGRAM_BOT_TOKEN,
          Number(env.TELEGRAM_ANNOUNCEMENT_CHANNEL_ID),
          `💸 Retrait effectué : ${wr.amount.toFixed(2)} USDT → ${shortAddress}\nTx : <code>${txHash}</code>`
        );
      }
    } catch (err) {
      console.error(`Erreur traitement retrait #${wr.id}:`, err);
      await env.DB.prepare("UPDATE withdrawal_requests SET status = 'failed' WHERE id = ?").bind(wr.id).run();
    }
  }
}

// 5. Auto-approuve les demandes sous le seuil (celles au-dessus attendent une action admin)
async function autoApproveBelowThreshold(env: Env) {
  const rawThreshold = env.WITHDRAWAL_AUTO_THRESHOLD_USDT?.trim();
  const threshold = rawThreshold ? Number(rawThreshold) : Infinity;
  await env.DB.prepare(
    `UPDATE withdrawal_requests SET status = 'approved'
     WHERE status = 'pending' AND requires_admin_approval = 0 AND amount <= ?`
  )
    .bind(threshold)
    .run();
}

// 6. Prévient l'admin des demandes de retrait en attente de validation manuelle
//    (ne renotifie pas celles déjà signalées, via notified_admin_at)
async function notifyAdminOfPendingApprovals(env: Env) {
  if (!env.ADMIN_TELEGRAM_CHAT_ID) return;

  const pending = await env.DB.prepare(
    `SELECT w.*, u.telegram_id, u.username
     FROM withdrawal_requests w
     JOIN deposits d ON d.id = w.deposit_id
     JOIN users u ON u.id = d.user_id
     WHERE w.status = 'pending' AND w.requires_admin_approval = 1 AND w.notified_admin_at IS NULL`
  ).all<any>();

  for (const wr of pending.results ?? []) {
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      Number(env.ADMIN_TELEGRAM_CHAT_ID),
      `🔔 Retrait #${wr.id} en attente de validation : ${wr.amount.toFixed(2)} USDT vers ${wr.destination_address} (utilisateur ${wr.username ?? wr.telegram_id}).\nValide via l'API : POST /admin/api/withdrawals/${wr.id}/approve`
    );
    await env.DB.prepare("UPDATE withdrawal_requests SET notified_admin_at = datetime('now') WHERE id = ?")
      .bind(wr.id)
      .run();
  }
}

// --- Verrou anti-chevauchement : évite que deux exécutions du cron tournent en parallèle
// si un passage prend plus de temps que l'intervalle entre deux déclenchements. ---
const LOCK_MAX_AGE_MS = 4 * 60 * 1000; // une exécution ne devrait jamais dépasser 4 min

async function acquireLock(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT locked_at FROM cron_locks WHERE id = 1").first<any>();
  if (row?.locked_at) {
    const lockedAt = new Date(row.locked_at + "Z").getTime();
    if (Date.now() - lockedAt < LOCK_MAX_AGE_MS) {
      return false; // un autre passage est déjà en cours
    }
    // Verrou expiré (passage précédent probablement en erreur) : on le reprend
  }
  await env.DB.prepare("UPDATE cron_locks SET locked_at = datetime('now') WHERE id = 1").run();
  return true;
}

async function releaseLock(env: Env) {
  await env.DB.prepare("UPDATE cron_locks SET locked_at = NULL WHERE id = 1").run();
}

export async function runScheduledTasks(env: Env) {
  const gotLock = await acquireLock(env);
  if (!gotLock) {
    console.log("Cron déjà en cours, passage ignoré.");
    return;
  }

  try {
    await checkPendingDeposits(env);
    await sweepConfirmedDeposits(env);
    await checkMaturedDeposits(env);
    await autoApproveBelowThreshold(env);
    await processApprovedWithdrawals(env);
    await notifyAdminOfPendingApprovals(env);
  } finally {
    await releaseLock(env);
  }
}
