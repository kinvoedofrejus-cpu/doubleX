// Encodage Base58Check utilisé par les adresses TRON.
// Implémentation pure JS (compatible Cloudflare Workers, aucune dépendance Node).

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const b of bytes) result = (result << 8n) + BigInt(b);
  return result;
}

export function base58Encode(bytes: Uint8Array): string {
  let value = bytesToBigInt(bytes);
  let result = "";
  const base = 58n;
  while (value > 0n) {
    const mod = value % base;
    result = ALPHABET[Number(mod)] + result;
    value = value / base;
  }
  // Préserve les zéros de tête (chaque 0x00 initial = '1')
  for (const b of bytes) {
    if (b === 0) result = "1" + result;
    else break;
  }
  return result;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

export async function base58CheckEncode(payload: Uint8Array): Promise<string> {
  const firstHash = await sha256(payload);
  const secondHash = await sha256(firstHash);
  const checksum = secondHash.slice(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload, 0);
  full.set(checksum, payload.length);
  return base58Encode(full);
}
