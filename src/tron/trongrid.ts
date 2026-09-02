// Client TronGrid (API HTTP TRON) : lecture des transactions TRC20 entrantes,
// construction, signature et diffusion d'un transfert USDT sortant.
//
// ⚠️ IMPORTANT : le code de signature/diffusion touche à de vrais fonds.
// Teste-le abondamment sur le réseau de test (Nile/Shasta) avant toute mise en
// production, et fais valider la logique par quelqu'un qui connaît bien TRON.

import * as secp from "@noble/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { hexToBytes, tronAddressToHex } from "./wallet";

export interface Env {
  TRONGRID_API_URL: string;
  TRONGRID_API_KEY?: string;
  USDT_TRC20_CONTRACT: string;
}

function headers(env: Env) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (env.TRONGRID_API_KEY) h["TRON-PRO-API-KEY"] = env.TRONGRID_API_KEY;
  return h;
}

// Liste les transferts TRC20 reçus par une adresse (utilisé par le cron de détection des dépôts)
export async function getTrc20TransfersReceived(
  env: Env,
  address: string,
  sinceTimestampMs: number
) {
  const url = `${env.TRONGRID_API_URL}/v1/accounts/${address}/transactions/trc20?limit=20&contract_address=${env.USDT_TRC20_CONTRACT}&only_to=true&min_timestamp=${sinceTimestampMs}`;
  const res = await fetch(url, { headers: headers(env) });
  if (!res.ok) throw new Error(`TronGrid error ${res.status}: ${await res.text()}`);
  const data = await res.json<{ data: any[] }>();
  return data.data ?? [];
}

// Construit une transaction TRC20 "transfer(address,uint256)" non signée
async function buildTrc20Transfer(
  env: Env,
  ownerAddressHex: string,
  toAddressHex: string,
  amountRaw: bigint
) {
  const functionSelector = "transfer(address,uint256)";
  const toParam = toAddressHex.replace(/^41/, "").padStart(64, "0");
  const amountParam = amountRaw.toString(16).padStart(64, "0");
  const parameter = toParam + amountParam;

  const body = {
    owner_address: ownerAddressHex,
    contract_address: tronAddressToHex(env.USDT_TRC20_CONTRACT).length
      ? addrToHexIfNeeded(env.USDT_TRC20_CONTRACT)
      : env.USDT_TRC20_CONTRACT,
    function_selector: functionSelector,
    parameter,
    fee_limit: 100_000_000, // 100 TRX max de frais, ajuste selon besoin
    call_value: 0,
    visible: false,
  };

  const res = await fetch(`${env.TRONGRID_API_URL}/wallet/triggersmartcontract`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`TronGrid triggersmartcontract error: ${await res.text()}`);
  return res.json<any>();
}

function addrToHexIfNeeded(addr: string) {
  return addr.startsWith("T") ? tronAddressToHex(addr) : addr;
}

// Signe une transaction TRON (raw_data_hex) avec la clé privée du portefeuille de dépôt
async function signTransaction(rawDataHex: string, privateKeyHex: string) {
  const txIdBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", hexToBytes(rawDataHex))
  );
  const sig = await secp.signAsync(txIdBytes, hexToBytes(privateKeyHex));
  const r = sig.r.toString(16).padStart(64, "0");
  const s = sig.s.toString(16).padStart(64, "0");
  const v = (sig.recovery + 27).toString(16).padStart(2, "0");
  return r + s + v;
}

// Envoie amountRaw (unités USDT * 10^6, car USDT TRC20 a 6 décimales) depuis le
// portefeuille de dépôt (ownerAddress / privateKey) vers destinationAddress.
export async function sendTrc20(
  env: Env,
  ownerAddress: string,
  privateKeyHex: string,
  destinationAddress: string,
  amountRaw: bigint
) {
  const ownerHex = tronAddressToHex(ownerAddress);
  const toHex = tronAddressToHex(destinationAddress);

  const built = await buildTrc20Transfer(env, ownerHex, toHex, amountRaw);
  if (!built.result?.result) {
    throw new Error(`Échec de construction de la transaction: ${JSON.stringify(built)}`);
  }

  const transaction = built.transaction;
  const signature = await signTransaction(transaction.raw_data_hex, privateKeyHex);
  transaction.signature = [signature];

  const res = await fetch(`${env.TRONGRID_API_URL}/wallet/broadcasttransaction`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify(transaction),
  });
  if (!res.ok) throw new Error(`Échec de diffusion: ${await res.text()}`);
  const result = await res.json<any>();
  if (!result.result) throw new Error(`Diffusion refusée par le réseau: ${JSON.stringify(result)}`);
  return { txHash: transaction.txID as string };
}

// Récupère le solde TRX d'une adresse (utile pour vérifier qu'elle a assez de TRX pour payer les frais)
export async function getTrxBalance(env: Env, addressHex: string): Promise<number> {
  const res = await fetch(`${env.TRONGRID_API_URL}/wallet/getaccount`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ address: addressHex, visible: false }),
  });
  const data = await res.json<any>();
  return (data.balance ?? 0) / 1_000_000;
}

// Envoie du TRX natif (pas un jeton TRC20) — utilisé pour "essencer" une adresse
// de dépôt tout juste créée avant qu'elle puisse payer les frais du sweep USDT.
export async function sendTrx(
  env: Env,
  ownerAddress: string,
  privateKeyHex: string,
  destinationAddress: string,
  amountTrx: number
) {
  const ownerHex = tronAddressToHex(ownerAddress);
  const toHex = tronAddressToHex(destinationAddress);
  const amountSun = Math.round(amountTrx * 1_000_000);

  const res = await fetch(`${env.TRONGRID_API_URL}/wallet/createtransaction`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({
      owner_address: ownerHex,
      to_address: toHex,
      amount: amountSun,
      visible: false,
    }),
  });
  if (!res.ok) throw new Error(`Échec createtransaction: ${await res.text()}`);
  const transaction = await res.json<any>();
  if (!transaction.txID) throw new Error(`Transaction TRX invalide: ${JSON.stringify(transaction)}`);

  const signature = await signTransaction(transaction.raw_data_hex, privateKeyHex);
  transaction.signature = [signature];

  const broadcastRes = await fetch(`${env.TRONGRID_API_URL}/wallet/broadcasttransaction`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify(transaction),
  });
  const result = await broadcastRes.json<any>();
  if (!result.result) throw new Error(`Diffusion TRX refusée: ${JSON.stringify(result)}`);
  return { txHash: transaction.txID as string };
}
