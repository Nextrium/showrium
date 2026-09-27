import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isPlatformAdmin, readCookie } from "@nextrium/core";

const BASE = "http://localhost:5173";
const ORIGIN = { Origin: BASE };
let ipCounter = 0;
const ip = () => `10.4.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

function signUp(email: string, name: string, cookie?: string) {
  return SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ORIGIN, "CF-Connecting-IP": ip(), ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ email, name, password: "correct-horse-battery" }),
  });
}
const sessionCookie = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
async function adminSession() {
  const res = await signUp(`admin@example.com`, "Admin");
  if (res.status === 200) return sessionCookie(res);
  const signIn = await SELF.fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ORIGIN, "CF-Connecting-IP": ip() },
    body: JSON.stringify({ email: "admin@example.com", password: "correct-horse-battery" }),
  });
  return sessionCookie(signIn);
}
async function createInvite(cookie: string, note?: string) {
  return SELF.fetch(`${BASE}/api/v1/admin/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, ...ORIGIN },
    body: JSON.stringify(note ? { note } : {}),
  });
}
async function newInviteToken(cookie: string) {
  const res = await createInvite(cookie);
  expect(res.status).toBe(201);
  const { link } = (await res.json()) as { link: string };
  return new URL(link).searchParams.get("token")!;
}
/** Accepts the invite and returns the invite cookie to send with sign-up. */
async function accept(token: string) {
  return SELF.fetch(`${BASE}/api/v1/invites/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip() },
    body: JSON.stringify({ token }),
  });
}
const exists = async (email: string) =>
  Boolean(await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first());

describe("platform admin and cookie helpers", () => {
  it("accepts only exact emails; never wildcards or domains", () => {
    expect(isPlatformAdmin("Admin@Example.com", "admin@example.com")).toBe(true);
    expect(isPlatformAdmin("admin@example.com", "*")).toBe(false);
    expect(isPlatformAdmin("admin@example.com", "@example.com")).toBe(false);
    expect(isPlatformAdmin("admin@example.com", undefined)).toBe(false);
    expect(isPlatformAdmin(null, "admin@example.com")).toBe(false);
  });
  it("reads a cookie from a header", () => {
    expect(readCookie("a=1; showrium_invite=inv_x%3D; b=2", "showrium_invite")).toBe("inv_x=");
    expect(readCookie(null, "x")).toBeNull();
    expect(readCookie("showrium_invite_other=1", "showrium_invite")).toBeNull();
  });
});

describe("invite management", () => {
  it("only platform admins can create invites; members and API keys cannot", async () => {
    const member = sessionCookie(await signUp("member@example.com", "Member"));
    expect((await createInvite(member)).status).toBe(403);

    const admin = await adminSession();
    expect((await createInvite(admin, "for Kemi")).status).toBe(201);

    const keyRes = await SELF.fetch(`${BASE}/api/v1/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin, ...ORIGIN },
      body: JSON.stringify({ name: "admin key" }),
    });
    const { key } = (await keyRes.json()) as { key: string };
    const viaKey = await SELF.fetch(`${BASE}/api/v1/admin/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: "{}",
    });
    expect(viaKey.status).toBe(403);
  });

  it("never returns tokens or hashes in the list", async () => {
    const admin = await adminSession();
    const token = await newInviteToken(admin);
    const text = await (await SELF.fetch(`${BASE}/api/v1/admin/invites`, { headers: { Cookie: admin } })).text();
    expect(text).not.toContain(token);
    expect(text).not.toContain("token");
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });

  it("reports admin status to the app", async () => {
    const admin = await adminSession();
    const me = (await (await SELF.fetch(`${BASE}/api/v1/me`, { headers: { Cookie: admin } })).json()) as {
      principal: { isPlatformAdmin: boolean };
    };
    expect(me.principal.isPlatformAdmin).toBe(true);
  });
});

describe("invite redemption", () => {
  it("lets someone off the allowlist create an account, once", async () => {
    const admin = await adminSession();
    const token = await newInviteToken(admin);
    const acc = await accept(token);
    expect(acc.status).toBe(200);
    const setCookie = acc.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Path=\/api\/auth/i);
    const inviteCookie = setCookie.split(";")[0]!;

    expect((await signUp("guest@gmail-lookalike.io", "Guest", inviteCookie)).status).toBe(200);
    expect(await exists("guest@gmail-lookalike.io")).toBe(true);

    // Reusing the same link for a second account fails.
    expect((await signUp("second@gmail-lookalike.io", "Second", inviteCookie)).status).not.toBe(200);
    expect(await exists("second@gmail-lookalike.io")).toBe(false);
    expect((await accept(token)).status).toBe(400);
  });

  it("without an invite, someone off the allowlist is still blocked", async () => {
    expect((await signUp("nobody@outside.io", "Nobody")).status).not.toBe(200);
  });

  it("a forged cookie with a made-up token does nothing", async () => {
    const res = await signUp("forger@outside.io", "Forger", `showrium_invite=inv_${"A".repeat(43)}`);
    expect(res.status).not.toBe(200);
    expect(await exists("forger@outside.io")).toBe(false);
  });

  it("rejects expired and revoked invites", async () => {
    const admin = await adminSession();
    const expired = await newInviteToken(admin);
    await env.DB.prepare("UPDATE invite SET expires_at = 1 WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?")
      .bind(Date.now())
      .run();
    expect((await accept(expired)).status).toBe(400);

    const revokedToken = await newInviteToken(admin);
    const list = (await (await SELF.fetch(`${BASE}/api/v1/admin/invites`, { headers: { Cookie: admin } })).json()) as {
      data: { id: string; status: string }[];
    };
    const pending = list.data.find((i) => i.status === "pending")!;
    const del = await SELF.fetch(`${BASE}/api/v1/admin/invites/${pending.id}`, { method: "DELETE", headers: { Cookie: admin, ...ORIGIN } });
    expect(del.status).toBe(204);
    expect((await accept(revokedToken)).status).toBe(400);
  });

  it("rejects garbage tokens", async () => {
    for (const token of ["", "nope", "inv_short", `inv_${"x".repeat(96)}`]) {
      expect((await accept(token)).status).toBe(400);
    }
  });

  it("two sign-ups racing on one invite: exactly one account is created", async () => {
    const admin = await adminSession();
    const token = await newInviteToken(admin);
    const inviteCookie = (await accept(token)).headers.get("Set-Cookie")!.split(";")[0]!;
    const results = await Promise.all([
      signUp("race-a@outside.io", "A", inviteCookie),
      signUp("race-b@outside.io", "B", inviteCookie),
      signUp("race-c@outside.io", "C", inviteCookie),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const created = await Promise.all(["race-a@outside.io", "race-b@outside.io", "race-c@outside.io"].map(exists));
    expect(created.filter(Boolean)).toHaveLength(1);
  });
});
