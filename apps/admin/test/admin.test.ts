import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@nextrium/db";
import { createPersonalOrg, joinWaitlist } from "@nextrium/core";
import { verifyAccessToken } from "../worker/access";

const BASE = "https://admin.test";
const TEAM = "team.test.cloudflareaccess.com";
let keys: CryptoKeyPair;
let jwk: JsonWebKey;

const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

/** An Access-style token (RS256), signed with the test key unless another is given. */
async function token(email: string, over: Record<string, unknown> = {}, key = keys.privateKey, kid = "k1") {
  const head = enc({ alg: "RS256", kid, typ: "JWT" });
  const body = enc({ aud: ["test-aud"], iss: `https://${TEAM}`, email, exp: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000), ...over });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  jwk = { ...((await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey), kid: "k1" } as JsonWebKey;
});
// Access's public keys are served from the team domain: answered here, nothing leaves the test.
beforeEach(() => {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    return real(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

async function call(email: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(email ? { "Cf-Access-Jwt-Assertion": await token(email) } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json", Origin: BASE } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function makeUser(email: string) {
  const id = `u_${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 1)").bind(id, email.split("@")[0], email).run();
  const org = await createPersonalOrg(createDb(env.DB), { userId: id, userName: email.split("@")[0]! });
  return { id, orgId: org!.orgId };
}

describe("Access tokens", () => {
  const cfg = { teamDomain: TEAM, aud: "test-aud" };
  it("accepts a valid token, and refuses wrong audience, issuer, expiry, signature or key", async () => {
    expect(await verifyAccessToken(await token("Owner@Example.com"), cfg)).toBe("owner@example.com");
    expect(await verifyAccessToken(await token("a@example.com", { aud: ["other-app"] }), cfg)).toBeNull();
    expect(await verifyAccessToken(await token("a@example.com", { iss: "https://evil.cloudflareaccess.com" }), cfg)).toBeNull();
    expect(await verifyAccessToken(await token("a@example.com", { exp: Math.floor(Date.now() / 1000) - 5 }), cfg)).toBeNull();
    const other = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    expect(await verifyAccessToken(await token("a@example.com", {}, other.privateKey), cfg)).toBeNull(); // forged
    expect(await verifyAccessToken(await token("a@example.com", {}, keys.privateKey, "unknown-kid"), cfg)).toBeNull();
    expect(await verifyAccessToken("not.a.token", cfg)).toBeNull();
    const none = `${enc({ alg: "none", kid: "k1" })}.${enc({ aud: ["test-aud"], iss: `https://${TEAM}`, email: "a@example.com", exp: 9999999999 })}.`;
    expect(await verifyAccessToken(none, cfg)).toBeNull(); // "alg: none" is refused
  });
});

describe("admin API access", () => {
  it("is closed without Access, and to people who aren't staff", async () => {
    expect((await call(null, "GET", "/me")).status).toBe(401);
    expect((await call("stranger@example.com", "GET", "/me")).status).toBe(403);
    const me = await call("owner@example.com", "GET", "/me");
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "owner@example.com", role: "owner" });
    expect(me.headers.get("Cache-Control")).toBe("no-store");
  });

  it("refuses changes from other sites, and anything that isn't JSON", async () => {
    const t = await token("owner@example.com");
    const cross = await SELF.fetch(`${BASE}/api/staff`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": t, "Content-Type": "application/json", Origin: "https://evil.test" }, body: "{}" });
    expect(cross.status).toBe(403);
    const form = await SELF.fetch(`${BASE}/api/staff`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": t, "Content-Type": "text/plain", Origin: BASE }, body: "{}" });
    expect(form.status).toBe(415);
  });
});

describe("staff", () => {
  it("owners invite staff with a role; roles limit what they can do; removal is a soft revoke", async () => {
    // Invite someone without an account: a one-time account link comes back (email isn't set up in tests).
    const inv = await call("owner@example.com", "POST", "/staff", { email: "Helper@Example.com", role: "support" });
    expect(inv.status).toBe(201);
    const out = (await inv.json()) as { email: string; link: string | null; sent: boolean; hasAccount: boolean };
    expect(out).toMatchObject({ email: "helper@example.com", sent: false, hasAccount: false });
    expect(out.link).toMatch(/^https:\/\/app\.test\/invite\?token=inv_/);
    expect((await call("owner@example.com", "POST", "/staff", { email: "helper@example.com", role: "finance" })).status).toBe(409);

    // Support: overview, waitlist, users. Not plans, staff or activity.
    expect(((await (await call("helper@example.com", "GET", "/me")).json()) as { role: string }).role).toBe("support");
    expect((await call("helper@example.com", "GET", "/overview")).status).toBe(200);
    expect((await call("helper@example.com", "GET", "/waitlist")).status).toBe(200);
    expect((await call("helper@example.com", "GET", "/staff")).status).toBe(403);
    expect((await call("helper@example.com", "GET", "/audit")).status).toBe(403);
    const target = await makeUser("customer@example.com");
    expect((await call("helper@example.com", "PUT", `/workspaces/${target.orgId}/plan`, { plan: "pro", note: "test" })).status).toBe(403);

    // Change the role, then remove (soft): the row stays, access goes.
    const list = (await (await call("owner@example.com", "GET", "/staff")).json()) as { data: { id: string | null; email: string; fromSettings: boolean }[] };
    expect(list.data.find((m) => m.email === "owner@example.com")).toMatchObject({ fromSettings: true, id: null });
    const helper = list.data.find((m) => m.email === "helper@example.com")!;
    expect((await call("owner@example.com", "PATCH", `/staff/${helper.id}`, { role: "finance" })).status).toBe(204);
    expect((await call("helper@example.com", "GET", "/waitlist")).status).toBe(403); // finance can't
    expect((await call("owner@example.com", "PATCH", `/staff/${helper.id}`, { remove: true })).status).toBe(204);
    expect((await call("helper@example.com", "GET", "/me")).status).toBe(403);
    const row = await env.DB.prepare("SELECT revoked_at FROM staff_member WHERE email = 'helper@example.com'").first<{ revoked_at: number | null }>();
    expect(row?.revoked_at).toBeGreaterThan(0); // still there, marked removed
    // The account invite that came with it no longer works.
    const invRow = await env.DB.prepare("SELECT i.revoked_at FROM invite i JOIN staff_member s ON s.invite_id = i.id WHERE s.email = 'helper@example.com'").first<{ revoked_at: number | null }>();
    expect(invRow?.revoked_at).toBeGreaterThan(0);

    const audit = (await (await call("owner@example.com", "GET", "/audit")).json()) as { data: { action: string; actorEmail: string }[] };
    expect(audit.data.map((a) => a.action)).toEqual(expect.arrayContaining(["staff.invited", "staff.role_changed", "staff.removed"]));
    expect(audit.data.every((a) => a.actorEmail === "owner@example.com")).toBe(true);
  });

  it("only owners invite; nobody changes their own access", async () => {
    await call("owner@example.com", "POST", "/staff", { email: "boss2@example.com", role: "owner" });
    expect((await call("boss2@example.com", "GET", "/me")).status).toBe(200);
    const list = (await (await call("boss2@example.com", "GET", "/staff")).json()) as { data: { id: string | null; email: string }[] };
    const self = list.data.find((m) => m.email === "boss2@example.com")!;
    expect((await call("boss2@example.com", "PATCH", `/staff/${self.id}`, { remove: true })).status).toBe(403);
  });
});

describe("users and plans", () => {
  it("finds accounts, shows their workspaces without posts, and changes plans reversibly with a reason", async () => {
    const u = await makeUser("findme@example.com");
    const found = (await (await call("owner@example.com", "GET", "/users?q=findme")).json()) as { data: { id: string }[] };
    expect(found.data.map((x) => x.id)).toEqual([u.id]);
    const detail = (await (await call("owner@example.com", "GET", `/users/${u.id}`)).json()) as { workspaces: { id: string; plan: string }[] };
    expect(detail.workspaces[0]).toMatchObject({ id: u.orgId, plan: "free" });
    expect(JSON.stringify(detail)).not.toMatch(/"text"|"body"/); // no post content
    expect((await call("owner@example.com", "PUT", `/workspaces/${u.orgId}/plan`, { plan: "pro" })).status).toBe(400); // reason required
    expect((await call("owner@example.com", "PUT", `/workspaces/${u.orgId}/plan`, { plan: "pro", note: "beta tester" })).status).toBe(204);
    expect((await call("owner@example.com", "PUT", `/workspaces/${u.orgId}/plan`, { plan: "free", note: "beta over" })).status).toBe(204);
    expect((await call("owner@example.com", "PUT", `/workspaces/${u.orgId}/access`, { full: true, note: "partner" })).status).toBe(204);
    const plan = await env.DB.prepare("SELECT plan, full_access FROM org WHERE id = ?").bind(u.orgId).first();
    expect(plan).toEqual({ plan: "free", full_access: 1 });
  });
});

describe("waitlist", () => {
  it("invites from the waitlist and returns links to share when email isn't set up", async () => {
    await joinWaitlist(createDb(env.DB), "adm-wl@invitee.test");
    const list = (await (await call("owner@example.com", "GET", "/waitlist")).json()) as { data: { id: string; email: string; status: string }[] };
    const entry = list.data.find((e) => e.email === "adm-wl@invitee.test")!;
    expect(entry.status).toBe("waiting");
    const res = (await (await call("owner@example.com", "POST", "/waitlist/invite", { ids: [entry.id] })).json()) as { data: { sent: boolean; link: string }[] };
    expect(res.data[0]!.sent).toBe(false);
    expect(res.data[0]!.link).toMatch(/^https:\/\/app\.test\/invite\?token=/);
  });
});

describe("overview", () => {
  it("returns totals and 14 days, not anyone's content", async () => {
    const o = (await (await call("owner@example.com", "GET", "/overview")).json()) as { users: { total: number }; daily: unknown[] };
    expect(o.users.total).toBeGreaterThanOrEqual(0);
    expect(o.daily).toHaveLength(14);
  });
});
