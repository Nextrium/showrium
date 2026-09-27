// Account-state matrix (operational protocol 4.1, point 1), run against the real Worker.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "http://localhost:5173";
const ORIGIN = { Origin: BASE };
// Each test sign-up comes from its own client IP so the sign-in rate limit (10/min per IP) doesn't trip.
let ipCounter = 0;
const uniqueIp = () => `10.2.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

async function signUp(email: string, name: string) {
  return SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ORIGIN, "CF-Connecting-IP": uniqueIp() },
    body: JSON.stringify({ email, name, password: "correct-horse-battery" }),
  });
}
async function cookieFor(email: string, name: string) {
  const res = await signUp(email, name);
  expect(res.status).toBe(200);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
const me = (cookie: string) => SELF.fetch(`${BASE}/api/v1/me`, { headers: { Cookie: cookie } });
const createKey = (cookie: string) =>
  SELF.fetch(`${BASE}/api/v1/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, ...ORIGIN },
    body: JSON.stringify({ name: "k" }),
  });
async function userId(email: string) {
  const row = await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>();
  return row!.id;
}

describe("sign-up policy", () => {
  it("blocks emails that are not on the beta allowlist, and creates nothing", async () => {
    const res = await signUp("intruder@not-invited.io", "Intruder");
    expect(res.status).not.toBe(200);
    const row = await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind("intruder@not-invited.io").first();
    expect(row).toBeNull();
  });

  it("names the workspace from the first word of the name (extra spaces, names containing 's')", async () => {
    const cookie = await cookieFor("abdul@example.com", "  Abdulbasit   Ade ");
    const body = (await (await me(cookie)).json()) as { workspace: { name: string } };
    expect(body.workspace.name).toBe("Abdulbasit's workspace");
  });
});

describe("account-state matrix", () => {
  it("self-heals an account whose workspace was never created", async () => {
    const cookie = await cookieFor("orphan@example.com", "Orphan");
    await env.DB.prepare("DELETE FROM org WHERE personal_owner_user_id = ?").bind(await userId("orphan@example.com")).run();
    expect((await me(cookie)).status).toBe(200);
    const credits = (await (await SELF.fetch(`${BASE}/api/v1/credits`, { headers: { Cookie: cookie } })).json()) as {
      balance: number;
    };
    expect(credits.balance).toBe(20);
  });

  it("creates only one workspace when several first requests race", async () => {
    const cookie = await cookieFor("racer@example.com", "Racer");
    const id = await userId("racer@example.com");
    await env.DB.prepare("DELETE FROM org WHERE personal_owner_user_id = ?").bind(id).run();
    const results = await Promise.all([me(cookie), me(cookie), me(cookie), me(cookie)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const count = await env.DB.prepare("SELECT count(*) AS n FROM membership WHERE user_id = ?").bind(id).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("denies a member removed from their workspace (no silent re-grant)", async () => {
    const cookie = await cookieFor("removed@example.com", "Removed");
    await env.DB.prepare("DELETE FROM membership WHERE user_id = ?").bind(await userId("removed@example.com")).run();
    expect((await me(cookie)).status).toBe(403);
  });

  it.each([
    ["viewer", 403],
    ["approver", 403],
    ["editor", 403],
    ["admin", 201],
    ["owner", 201],
  ])("%s creating an API key -> %i", async (role, expected) => {
    const email = `role-${role}@example.com`;
    const cookie = await cookieFor(email, String(role));
    await env.DB.prepare("UPDATE membership SET role = ? WHERE user_id = ?").bind(role, await userId(email)).run();
    expect((await createKey(cookie)).status).toBe(expected);
  });

  it("rejects an expired session", async () => {
    const cookie = await cookieFor("expired@example.com", "Expired");
    await env.DB.prepare("UPDATE session SET expires_at = 0 WHERE user_id = ?").bind(await userId("expired@example.com")).run();
    expect((await me(cookie)).status).toBe(401);
  });

  it("rejects a deleted user's session", async () => {
    const cookie = await cookieFor("deleted@example.com", "Deleted");
    await env.DB.prepare("DELETE FROM user WHERE email = ?").bind("deleted@example.com").run();
    expect((await me(cookie)).status).toBe(401);
  });

  it("rejects malformed and unknown API keys", async () => {
    for (const auth of ["Bearer ", "Bearer shr_live_", "Bearer nope", `Bearer shr_live_${"x".repeat(43)}`]) {
      const res = await SELF.fetch(`${BASE}/api/v1/me`, { headers: { Authorization: auth } });
      expect(res.status).toBe(401);
    }
  });

  it("caps active API keys per workspace", async () => {
    const cookie = await cookieFor("many@example.com", "Many");
    for (let i = 0; i < 25; i++) expect((await createKey(cookie)).status).toBe(201);
    const res = await createKey(cookie);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("key_limit");
  });
});

describe("rate limiting", () => {
  it("slows repeated sign-in attempts from one IP (429 after the limit)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await SELF.fetch(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ORIGIN, "CF-Connecting-IP": "203.0.113.7" },
        body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password-123" }),
      });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
    expect(statuses.slice(0, 10)).not.toContain(429);
  });
});

describe("security headers", () => {
  it("sets hardening headers on API responses", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/health`);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=31536000");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("pins the docs script with integrity and a restrictive CSP", async () => {
    const res = await SELF.fetch(`${BASE}/api/docs`);
    expect(await res.text()).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });
});
