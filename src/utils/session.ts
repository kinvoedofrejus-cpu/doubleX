// Jetons de session signés (façon JWT minimal) pour authentifier les visiteurs
// du site web, + vérification cryptographique du widget "Login with Telegram".

function base64urlEncode(bytes: Uint8Array): string {
  let str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export interface SessionPayload {
  telegramId: number;
  exp: number; // timestamp Unix (secondes)
}

export async function createSessionToken(telegramId: number, secret: string, ttlSeconds = 60 * 60 * 24 * 30) {
  const payload: SessionPayload = { telegramId, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const payloadPart = base64urlEncode(payloadBytes);

  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadPart));
  const signaturePart = base64urlEncode(new Uint8Array(signature));

  return `${payloadPart}.${signaturePart}`;
}

export async function verifySessionToken(token: string, secret: string): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadPart, signaturePart] = parts;

  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64urlDecode(signaturePart),
    new TextEncoder().encode(payloadPart)
  );
  if (!valid) return null;

  try {
    const payload: SessionPayload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadPart)));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null; // expiré
    return payload;
  } catch {
    return null;
  }
}

// Vérifie l'authenticité des données renvoyées par le widget Telegram "Login with Telegram".
// Algorithme officiel : https://core.telegram.org/widgets/login#checking-authorization
export async function verifyTelegramLoginPayload(
  data: Record<string, string>,
  botToken: string
): Promise<boolean> {
  const { hash, ...rest } = data;
  if (!hash) return false;

  // Le lien de connexion doit dater de moins de 24h
  const authDate = Number(rest.auth_date ?? "0");
  if (!authDate || Date.now() / 1000 - authDate > 86400) return false;

  const dataCheckString = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join("\n");

  const secretKeyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(botToken));
  const secretKey = await crypto.subtle.importKey("raw", secretKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const expectedSignature = await crypto.subtle.sign("HMAC", secretKey, new TextEncoder().encode(dataCheckString));
  const expectedHex = Array.from(new Uint8Array(expectedSignature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return expectedHex === hash;
}
