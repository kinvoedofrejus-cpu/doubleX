// Génération d'un portefeuille TRON (adresse + clé privée) à partir de secp256k1.
// TRON utilise la même courbe qu'Ethereum, mais un hash Keccak256 + encodage
// Base58Check avec préfixe 0x41 pour dériver l'adresse.

import * as secp from "@noble/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { base58CheckEncode } from "../utils/base58";

export interface TronWallet {
  privateKeyHex: string;
  address: string; // format base58 (commence par "T")
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

export async function generateTronWallet(): Promise<TronWallet> {
  const privateKey = secp.utils.randomPrivateKey();
  const publicKeyUncompressed = secp.getPublicKey(privateKey, false); // 65 bytes, préfixe 0x04
  const pubKeyNoPrefix = publicKeyUncompressed.slice(1); // retire le 0x04

  const hash = keccak_256(pubKeyNoPrefix);
  const addressBytes20 = hash.slice(-20); // 20 derniers octets

  const payload = new Uint8Array(21);
  payload[0] = 0x41; // préfixe mainnet TRON
  payload.set(addressBytes20, 1);

  const address = await base58CheckEncode(payload);

  return {
    privateKeyHex: bytesToHex(privateKey),
    address,
  };
}

// Convertit une adresse base58 TRON (T...) en adresse hex (41...) attendue par l'API TronGrid
export function tronAddressToHex(base58Address: string): string {
  // Décodage Base58 minimal, utilisé uniquement pour reconvertir nos propres adresses générées.
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = 0n;
  for (const char of base58Address) {
    num = num * 58n + BigInt(ALPHABET.indexOf(char));
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  // Retire les 4 octets de checksum à la fin (8 caractères hex)
  return hex.slice(0, -8);
}
