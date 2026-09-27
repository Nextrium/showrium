// Token encryption (AES-256-GCM, Web Crypto) and PKCE helpers.
// The key comes from the TOKEN_ENCRYPTION_KEY secret: 32 random bytes, base64-encoded.
// Additional authenticated data binds each ciphertext to its workspace and platform, so a
// secret copied into another row fails to decrypt.

export class EncryptionUnavailableError extends Error {
  constructor() {
    super("Account connections are not configured in this environment.");
    this.name = "EncryptionUnavailableError";
  }
}

const b64 = {
  encode: (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)),
  decode: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};
export const base64url = (bytes: Uint8Array) => b64.encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function importTokenKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) throw new EncryptionUnavailableError();
  const raw = b64.decode(secret.trim());
  if (raw.byteLength !== 32) throw new EncryptionUnavailableError();
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptJson(key: CryptoKey, value: unknown, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, key, data));
  const out = new Uint8Array(iv.byteLength + sealed.byteLength);
  out.set(iv);
  out.set(sealed, iv.byteLength);
  return `v1:${b64.encode(out)}`;
}

export async function decryptJson<T>(key: CryptoKey, sealed: string, aad: string): Promise<T> {
  if (!sealed.startsWith("v1:")) throw new Error("Unknown secret format.");
  const bytes = b64.decode(sealed.slice(3));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(aad) },
    key,
    bytes.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}
