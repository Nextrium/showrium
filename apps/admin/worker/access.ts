// Cloudflare Access puts a signed token (a JWT) on every request it lets through. We verify it
// ourselves: the signature (Access's public keys), the audience (this application), the issuer
// (our Access team) and the expiry. A request without a valid token is refused, so the app stays
// closed even if Access were misconfigured or the Worker were reached another way.
import type { Env } from "./env.js";

type Jwk = JsonWebKey & { kid?: string };
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const keyCache = new Map<string, { keys: Jwk[]; at: number }>();
const KEYS_TTL_MS = 10 * 60_000;

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
function b64urlJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlBytes(s))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function accessKeys(teamDomain: string, doFetch: FetchLike, force = false): Promise<Jwk[]> {
  const cached = keyCache.get(teamDomain);
  if (!force && cached && Date.now() - cached.at < KEYS_TTL_MS) return cached.keys;
  const res = await doFetch(`https://${teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Access keys: HTTP ${res.status}`);
  const keys = ((await res.json()) as { keys?: Jwk[] }).keys ?? [];
  keyCache.set(teamDomain, { keys, at: Date.now() });
  return keys;
}

/** The verified email in an Access token, or null if anything about it is wrong. */
export async function verifyAccessToken(token: string, cfg: { teamDomain: string; aud: string }, doFetch: FetchLike = fetch, now = Date.now()): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = b64urlJson(parts[0]!);
  const payload = b64urlJson(parts[1]!);
  if (!header || !payload || header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const audOk = Array.isArray(payload.aud) ? payload.aud.includes(cfg.aud) : payload.aud === cfg.aud;
  if (!audOk || payload.iss !== `https://${cfg.teamDomain}`) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;
  if (typeof payload.nbf === "number" && payload.nbf * 1000 > now + 60_000) return null;
  if (typeof payload.email !== "string" || !payload.email.includes("@")) return null;

  let jwk = (await accessKeys(cfg.teamDomain, doFetch)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await accessKeys(cfg.teamDomain, doFetch, true)).find((k) => k.kid === header.kid); // keys rotate
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  return ok ? payload.email.trim().toLowerCase() : null;
}

/** Who is making this request: the Access-verified email, or (local development only) ADMIN_DEV_EMAIL. */
export async function identify(req: Request, env: Env, doFetch: FetchLike = fetch): Promise<string | null> {
  const local = env.ADMIN_URL.startsWith("http://localhost");
  if (local && env.ADMIN_DEV_EMAIL) return env.ADMIN_DEV_EMAIL.trim().toLowerCase();
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null; // not set up: closed
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  try {
    return await verifyAccessToken(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD }, doFetch);
  } catch (error) {
    console.error("access token check failed", error instanceof Error ? error.message : error);
    return null;
  }
}
