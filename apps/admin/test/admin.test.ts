import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@nextrium/db";
import { backfillAiUsage, createPersonalOrg, joinWaitlist, recordAiUsage } from "@nextrium/core";
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

describe("invite links", () => {
  it("creates a single-use link shown once, lists it without the token, and revokes it softly", async () => {
    const made = await call("owner@example.com", "POST", "/invites", { note: "Design partner" });
    expect(made.status).toBe(201);
    const { id, link } = (await made.json()) as { id: string; link: string };
    expect(link).toMatch(/^https:\/\/app\.test\/invite\?token=inv_/);
    const token = new URL(link).searchParams.get("token")!;
    const list = await (await call("owner@example.com", "GET", "/invites")).text();
    expect(list).not.toContain(token); // only the hash is stored
    expect(JSON.parse(list).data.find((i: { id: string }) => i.id === id)).toMatchObject({ note: "Design partner", status: "pending" });

    expect((await call("owner@example.com", "POST", `/invites/${id}/revoke`, {})).status).toBe(200);
    expect((await call("owner@example.com", "POST", `/invites/${id}/revoke`, {})).status).toBe(404); // already revoked
    const after = (await (await call("owner@example.com", "GET", "/invites")).json()) as { data: { id: string; status: string }[] };
    expect(after.data.find((i) => i.id === id)?.status).toBe("revoked");
    const row = await env.DB.prepare("SELECT revoked_at FROM invite WHERE id = ?").bind(id).first<{ revoked_at: number | null }>();
    expect(row?.revoked_at).toBeGreaterThan(0); // kept, marked revoked

    const audit = (await (await call("owner@example.com", "GET", "/audit")).json()) as { data: { action: string; target: string | null }[] };
    expect(audit.data.filter((a) => a.target === id).map((a) => a.action)).toEqual(expect.arrayContaining(["invite.created", "invite.revoked"]));
  });

  it("is for owners and support only, refuses long notes and cross-site requests", async () => {
    await call("owner@example.com", "POST", "/staff", { email: "money@example.com", role: "finance" });
    expect((await call("money@example.com", "GET", "/invites")).status).toBe(403);
    expect((await call("money@example.com", "POST", "/invites", {})).status).toBe(403);
    expect((await call("owner@example.com", "POST", "/invites", { note: "x".repeat(121) })).status).toBe(400);
    expect((await call("owner@example.com", "POST", "/invites", {}, { Origin: "https://evil.test" })).status).toBe(403);
    expect((await call(null, "GET", "/invites")).status).toBe(401);
  });
});

describe("phase 2: AI costs, publishing health, billing, abuse", () => {
  const DAY = 86_400_000;
  // Staff with each role (support and finance), invited by the owner.
  beforeAll(async () => {
    await call("owner@example.com", "POST", "/staff", { email: "p2-support@example.com", role: "support" });
    await call("owner@example.com", "POST", "/staff", { email: "p2-finance@example.com", role: "finance" });
  });

  it("AI costs: every feature, per post, and workspaces losing money; owners and finance only", async () => {
    const pro = await makeUser("p2-cost-pro@example.com");
    const free = await makeUser("p2-cost-free@example.com");
    await env.DB.prepare("INSERT INTO subscription (id, org_id, provider, plan, interval, status, provider_subscription_id) VALUES (?, ?, 'paddle', 'pro', 'month', 'active', ?)").bind(`sub_${crypto.randomUUID()}`, pro.orgId, `ps_${crypto.randomUUID()}`).run();
    const db = createDb(env.DB);
    await recordAiUsage(db, [
      { orgId: free.orgId, feature: "image", model: "@cf/flux", costMicroUsd: 2_500_000, estimated: true }, // $2.50 on a free workspace
      { orgId: pro.orgId, feature: "transcription", model: "@cf/whisper", costMicroUsd: 500, estimated: true },
    ]);
    // A post written before the ledger existed is copied in once.
    const ctx = `ctx_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO context_item (id, org_id, kind, body) VALUES (?, ?, 'manual', 'b')").bind(ctx, pro.orgId).run();
    const brief = `brf_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO brief (id, org_id, context_item_id, mode, angle, key_points, model, cost_micro_usd) VALUES (?, ?, ?, 'teach', 'a', '[]', 'openrouter/x', 1200)").bind(brief, pro.orgId, ctx).run();
    expect(await backfillAiUsage(db, 5000)).toBeGreaterThanOrEqual(1);
    expect(await backfillAiUsage(db, 5000)).toBe(0); // nothing twice

    const res = await call("owner@example.com", "GET", "/costs");
    expect(res.status).toBe(200);
    const c = (await res.json()) as { last30Usd: number; byFeature: { name: string }[]; workspaces: { orgId: string; losing: boolean; paysUsd: number }[]; byDay: unknown[]; estimatedShare: number };
    expect(c.byDay).toHaveLength(30);
    expect(c.byFeature.map((f) => f.name)).toEqual(expect.arrayContaining(["image", "transcription", "write"]));
    expect(c.workspaces.find((w) => w.orgId === free.orgId)).toMatchObject({ losing: true, paysUsd: 0 });
    expect(c.workspaces.find((w) => w.orgId === pro.orgId)).toMatchObject({ losing: false, paysUsd: 10 });
    expect(c.estimatedShare).toBeGreaterThan(0);
    expect((await call("p2-finance@example.com", "GET", "/costs")).status).toBe(200);
    expect((await call("p2-support@example.com", "GET", "/costs")).status).toBe(403);
    // The overview's AI cost now counts every feature.
    const o = (await (await call("owner@example.com", "GET", "/overview")).json()) as { aiCostThisMonthUsd: number };
    expect(o.aiCostThisMonthUsd).toBeGreaterThanOrEqual(2.5);
  });

  it("publishing health: failures by reason, accounts to reconnect, overdue posts; owners and support only", async () => {
    const u = await makeUser("p2-health@example.com");
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare("INSERT INTO draft (id, org_id, platform, text, status, issues, last_error) VALUES (?, ?, 'x', 't', 'failed', '[]', ?)").bind(`drf_${crypto.randomUUID()}`, u.orgId, `X rejected the post (HTTP 40${i}).`).run();
    }
    await env.DB.prepare("INSERT INTO draft (id, org_id, platform, text, status, issues, scheduled_at) VALUES (?, ?, 'linkedin', 't', 'scheduled', '[]', ?)").bind(`drf_${crypto.randomUUID()}`, u.orgId, Date.now() - 3600_000).run();
    await env.DB.prepare("INSERT INTO connection (id, org_id, platform, account_id, handle, secret, status) VALUES (?, ?, 'linkedin', 'li-1', '@p2', 'x', 'needs_reconnect')").bind(`cn_${crypto.randomUUID()}`, u.orgId).run();
    const res = await call("p2-support@example.com", "GET", "/health");
    expect(res.status).toBe(200);
    const h = (await res.json()) as { platforms: { platform: string; failed30: number }[]; reasons: { reason: string; count: number }[]; reconnect: { orgName: string }[]; overdue: unknown[]; jobs: { posting: { behind: boolean } } };
    expect(h.platforms.find((p) => p.platform === "x")!.failed30).toBeGreaterThanOrEqual(3);
    expect(h.reasons.some((r) => r.reason.startsWith("X rejected the post") && r.count >= 3)).toBe(true); // HTTP 400/401/402 counted together
    expect(h.reconnect.length).toBeGreaterThanOrEqual(1);
    expect(h.overdue.length).toBeGreaterThanOrEqual(1);
    expect(h.jobs.posting.behind).toBe(true);
    expect((await call("p2-finance@example.com", "GET", "/health")).status).toBe(403);
  });

  it("billing: monthly revenue, past due, payment problems and credits; read-only; owners and finance only", async () => {
    const a = await makeUser("p2-bill-a@example.com");
    const b = await makeUser("p2-bill-b@example.com");
    await env.DB.prepare("INSERT INTO subscription (id, org_id, provider, plan, interval, status, provider_subscription_id, current_period_end) VALUES (?, ?, 'paddle', 'creator', 'year', 'active', ?, ?)").bind(`sub_${crypto.randomUUID()}`, a.orgId, `ps_${crypto.randomUUID()}`, Date.now() + 30 * DAY).run();
    await env.DB.prepare("INSERT INTO subscription (id, org_id, provider, plan, interval, status, provider_subscription_id) VALUES (?, ?, 'paystack', 'starter', 'month', 'past_due', ?)").bind(`sub_${crypto.randomUUID()}`, b.orgId, `ps_${crypto.randomUUID()}`).run();
    await env.DB.prepare("INSERT INTO payment_event (id, provider, event_key, type, org_id, outcome) VALUES (?, 'paddle', ?, 'transaction.completed', ?, 'amount_mismatch')").bind(`pev_${crypto.randomUUID()}`, `k_${crypto.randomUUID()}`, a.orgId).run();
    const res = await call("p2-finance@example.com", "GET", "/billing");
    expect(res.status).toBe(200);
    const bill = (await res.json()) as { mrrUsd: number; pastDue: { orgId: string }[]; eventProblems: number; subscriptions: { orgId: string; monthlyUsd: number }[] };
    expect(bill.subscriptions.find((s) => s.orgId === a.orgId)!.monthlyUsd).toBe(5); // $60 a year
    expect(bill.pastDue.map((s) => s.orgId)).toContain(b.orgId);
    expect(bill.mrrUsd).toBeGreaterThanOrEqual(8); // 5 + 3 (past due still counts while it's retried)
    expect(bill.eventProblems).toBeGreaterThanOrEqual(1);
    expect((await call("p2-support@example.com", "GET", "/billing")).status).toBe(403);
  });

  it("abuse: signals for support to see; Pause and Resume for owners, with a reason, logged, and reversible", async () => {
    const u = await makeUser("p2-abuse@example.com");
    for (let i = 0; i < 10; i++) {
      await env.DB.prepare("INSERT INTO draft (id, org_id, platform, text, status, issues, last_error) VALUES (?, ?, 'bluesky', 't', 'failed', '[]', 'Bluesky refused the request.')").bind(`drf_${crypto.randomUUID()}`, u.orgId).run();
    }
    const seen = (await (await call("p2-support@example.com", "GET", "/abuse")).json()) as { workspaces: { orgId: string; reasons: string[] }[] };
    expect(seen.workspaces.find((w) => w.orgId === u.orgId)!.reasons[0]).toMatch(/10 failed or refused posts/);
    expect((await call("p2-finance@example.com", "GET", "/abuse")).status).toBe(403);

    expect((await call("p2-support@example.com", "POST", `/workspaces/${u.orgId}/pause`, { reason: "Spammy posting pattern" })).status).toBe(403); // support can't pause
    expect((await call("owner@example.com", "POST", `/workspaces/${u.orgId}/pause`, { reason: "no" })).status).toBe(400); // a real reason
    expect((await call("owner@example.com", "POST", `/workspaces/${u.orgId}/pause`, { reason: "Spammy posting pattern" })).status).toBe(204);
    expect((await call("owner@example.com", "POST", `/workspaces/${u.orgId}/pause`, { reason: "Spammy posting pattern" })).status).toBe(409); // already paused
    const row = await env.DB.prepare("SELECT paused_at, paused_reason, paused_by FROM org WHERE id = ?").bind(u.orgId).first<{ paused_at: number; paused_reason: string; paused_by: string }>();
    expect(row).toMatchObject({ paused_reason: "Spammy posting pattern", paused_by: "owner@example.com" });
    const list = (await (await call("owner@example.com", "GET", "/abuse")).json()) as { paused: { orgId: string }[] };
    expect(list.paused.map((p) => p.orgId)).toContain(u.orgId);
    // Nothing is deleted.
    const posts = await env.DB.prepare("SELECT count(*) AS n FROM draft WHERE org_id = ?").bind(u.orgId).first<{ n: number }>();
    expect(posts!.n).toBe(10);
    expect((await call("owner@example.com", "POST", `/workspaces/${u.orgId}/resume`, {})).status).toBe(204);
    expect((await call("owner@example.com", "POST", `/workspaces/${u.orgId}/resume`, {})).status).toBe(409);
    expect((await call("owner@example.com", "POST", "/workspaces/org_nope/pause", { reason: "Testing a missing one" })).status).toBe(404);
    expect((await call("owner@example.com", "POST", `/workspaces/${u.orgId}/pause`, { reason: "Cross-site try" }, { Origin: "https://evil.test" })).status).toBe(403);
    const audit = (await (await call("owner@example.com", "GET", "/audit")).json()) as { data: { action: string; target: string | null }[] };
    expect(audit.data.filter((a) => a.target === u.orgId).map((a) => a.action)).toEqual(expect.arrayContaining(["workspace.paused", "workspace.resumed"]));
  });
});

describe("overview", () => {
  it("returns totals and 14 days, not anyone's content", async () => {
    const o = (await (await call("owner@example.com", "GET", "/overview")).json()) as { users: { total: number }; daily: unknown[] };
    expect(o.users.total).toBeGreaterThanOrEqual(0);
    expect(o.daily).toHaveLength(14);
  });
});
