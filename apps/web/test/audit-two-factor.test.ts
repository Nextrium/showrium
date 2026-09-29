// Release audit: two-step sign-in (authenticator app) and signing out other devices.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.21.${Math.floor(++n / 250)}.${n % 250}`;
const post = (path: string, body: unknown, cookie = "") =>
  SELF.fetch(`${BASE}/api/auth${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip(), ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const get = (path: string, cookie: string) => SELF.fetch(`${BASE}/api/auth${path}`, { headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip() } });
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits), as authenticator apps compute it. */
async function totp(base32: string, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of base32.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = new Uint8Array(Math.floor(bits.length / 8)).map((_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2));
  const counter = new ArrayBuffer(8);
  new DataView(counter).setUint32(4, Math.floor(at / 1000 / 30));
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", k, counter));
  const o = h[19]! & 0xf;
  const code = (((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000;
  return String(code).padStart(6, "0");
}

describe("release audit: two-step sign-in", () => {
  it("turns on with a real code, then sign-in needs the code (or a backup code)", async () => {
    const email = "twostep@example.com";
    const password = "correct-horse-battery";
    const cookie = cookiesOf(await post("/sign-up/email", { email, name: "Two", password }));

    const enabled = (await (await post("/two-factor/enable", { password }, cookie)).json()) as { totpURI: string; backupCodes: string[] };
    const secret = new URL(enabled.totpURI).searchParams.get("secret")!;
    expect(enabled.backupCodes.length).toBeGreaterThanOrEqual(8);
    expect((await post("/two-factor/verify-totp", { code: "000000" }, cookie)).status).toBeGreaterThanOrEqual(400);
    expect((await post("/two-factor/verify-totp", { code: await totp(secret) }, cookie)).status).toBe(200);
    expect((await env.DB.prepare("SELECT two_factor_enabled FROM user WHERE email = ?").bind(email).first<{ two_factor_enabled: number }>())!.two_factor_enabled).toBe(1);
    // The secret is stored encrypted, not as the plain key.
    const stored = await env.DB.prepare("SELECT secret FROM two_factor").first<{ secret: string }>();
    expect(stored!.secret).not.toContain(secret);

    // Password alone is no longer enough: no session, a pending two-step cookie instead.
    const first = await post("/sign-in/email", { email, password });
    const body = (await first.json()) as { twoFactorRedirect?: boolean; token?: string };
    expect(body.twoFactorRedirect).toBe(true);
    const pending = cookiesOf(first);
    expect((await SELF.fetch(`${BASE}/api/v1/me`, { headers: { Cookie: pending } })).status).toBe(401);
    const done = await post("/two-factor/verify-totp", { code: await totp(secret) }, pending);
    expect(done.status).toBe(200);
    expect((await SELF.fetch(`${BASE}/api/v1/me`, { headers: { Cookie: cookiesOf(done) } })).status).toBe(200);

    // A backup code works once.
    const again = cookiesOf(await post("/sign-in/email", { email, password }));
    expect((await post("/two-factor/verify-backup-code", { code: enabled.backupCodes[0] }, again)).status).toBe(200);
    const third = cookiesOf(await post("/sign-in/email", { email, password }));
    expect((await post("/two-factor/verify-backup-code", { code: enabled.backupCodes[0] }, third)).status).toBeGreaterThanOrEqual(400);
  });

  it("session cookies can't be read by scripts and aren't sent cross-site", async () => {
    const res = await post("/sign-up/email", { email: "cookies@example.com", name: "C", password: "correct-horse-battery" });
    const session = res.headers.getSetCookie().find((c) => /session_token=/.test(c))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).toMatch(/Path=\//);
    // Secure is added automatically on https (preview and production); this test runs on http://localhost.
  });

  it("lists devices and signs out the others", async () => {
    const email = "devices@example.com";
    const password = "correct-horse-battery";
    const a = cookiesOf(await post("/sign-up/email", { email, name: "Dev", password }));
    const b = cookiesOf(await post("/sign-in/email", { email, password }));
    const sessions = (await (await get("/list-sessions", a)).json()) as unknown[];
    expect(sessions.length).toBe(2);
    expect((await post("/revoke-other-sessions", {}, a)).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/api/v1/me`, { headers: { Cookie: b } })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/v1/me`, { headers: { Cookie: a } })).status).toBe(200);
  });
});
