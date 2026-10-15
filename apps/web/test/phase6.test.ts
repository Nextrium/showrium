import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb } from "@nextrium/db";
import { createCheckout, expireSubscriptions, signCustom, verifySignature, type BillingConfig } from "@nextrium/core";

const BASE = "http://localhost:5173";
const ORIGIN = { Origin: BASE };
let n = 0;
const ip = () => `10.9.${Math.floor(++n / 250)}.${n % 250}`;
const e = env as unknown as Record<string, string>;

async function signUp(email: string, extraCookie = "") {
  return SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ORIGIN, "CF-Connecting-IP": ip(), ...(extraCookie ? { Cookie: extraCookie } : {}) },
    body: JSON.stringify({ email, name: "T", password: "correct-horse-battery" }),
  });
}

async function user(email: string, plan?: string) {
  const res = await signUp(email);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    SELF.fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: { Cookie: cookie, ...ORIGIN, "CF-Connecting-IP": ip(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string } };
  const row = await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>();
  if (plan) await env.DB.prepare("UPDATE org SET plan = ? WHERE id = ?").bind(plan, me.workspace.id).run();
  return { call, cookie, orgId: me.workspace.id, userId: row!.id };
}

async function hmac(algo: "SHA-256" | "SHA-512", secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: algo }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function paystack(event: unknown, sig?: string) {
  const raw = JSON.stringify(event);
  const res = await SELF.fetch(`${BASE}/api/v1/webhooks/paystack`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip(), "x-paystack-signature": sig ?? (await hmac("SHA-512", e.PAYSTACK_SECRET_KEY!, raw)) }, body: raw });
  return { status: res.status, body: (await res.json()) as { outcome?: string } };
}
async function lemon(event: unknown) {
  const raw = JSON.stringify(event);
  const res = await SELF.fetch(`${BASE}/api/v1/webhooks/lemonsqueezy`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip(), "X-Signature": await hmac("SHA-256", e.LEMONSQUEEZY_WEBHOOK_SECRET!, raw) }, body: raw });
  return { status: res.status, body: (await res.json()) as { outcome?: string } };
}
const custom = (orgId: string, item: string) => signCustom(e.BETTER_AUTH_SECRET!, orgId, item);
const balance = async (u: { call: (m: string, p: string) => Promise<Response> }) => ((await (await u.call("GET", "/credits")).json()) as { balance: number }).balance;
const plan = async (orgId: string) => (await env.DB.prepare("SELECT plan FROM org WHERE id = ?").bind(orgId).first<{ plan: string }>())!.plan;

describe("webhook signatures", () => {
  it("accepts only the provider's HMAC over the exact body", async () => {
    const sig = await hmac("SHA-512", "k", "{}");
    expect(await verifySignature("paystack", "k", "{}", sig)).toBe(true);
    expect(await verifySignature("paystack", "k", "{ }", sig)).toBe(false);
    expect(await verifySignature("paystack", "other", "{}", sig)).toBe(false);
    expect(await verifySignature("lemonsqueezy", "k", "{}", await hmac("SHA-256", "k", "{}"))).toBe(true);
    expect(await verifySignature("lemonsqueezy", "k", "{}", null)).toBe(false);
  });
  it("rejects unsigned or badly signed deliveries", async () => {
    expect((await paystack({ event: "charge.success", data: {} }, "00")).status).toBe(401);
  });
});

describe("Paystack", () => {
  it("grants a credit pack once, only for the right amount and a signed checkout", async () => {
    const u = await user("p6pay1@example.com");
    const start = await balance(u);
    const good = { event: "charge.success", data: { id: 9001, reference: "ref-1", status: "success", amount: 500 * 1500, currency: "NGN", metadata: await custom(u.orgId, "credits:c500") } };
    expect((await paystack(good)).body.outcome).toBe("credits_granted");
    expect((await paystack(good)).body.outcome).toBe("duplicate");
    expect(await balance(u)).toBe(start + 500);

    const cheap = { event: "charge.success", data: { ...good.data, id: 9002, reference: "ref-2", amount: 100 } };
    expect((await paystack(cheap)).body.outcome).toBe("amount_mismatch");
    // Metadata that we didn't sign (e.g. a payment made outside our checkout) is ignored.
    const forged = { event: "charge.success", data: { ...good.data, id: 9003, reference: "ref-3", metadata: { org_id: u.orgId, item: "credits:c500", sig: "0".repeat(32) } } };
    expect((await paystack(forged)).body.outcome).toBe("ignored_unsigned");
    expect(await balance(u)).toBe(start + 500);
  });

  it("runs a subscription from first payment to expiry", async () => {
    const u = await user("p6pay2@example.com");
    const first = { event: "charge.success", data: { id: 9101, reference: "ref-s1", status: "success", amount: 450000, currency: "NGN", plan: { plan_code: "PLN_starter" }, customer: { customer_code: "CUS_1" }, metadata: await custom(u.orgId, "starter:month") } };
    expect((await paystack(first)).body.outcome).toBe("applied");
    expect(await plan(u.orgId)).toBe("starter");
    const created = { event: "subscription.create", data: { id: 55, subscription_code: "SUB_1", plan: { plan_code: "PLN_starter" }, customer: { customer_code: "CUS_1" }, next_payment_date: new Date(Date.now() + 30 * 86_400_000).toISOString() } };
    expect((await paystack(created)).body.outcome).toBe("linked");
    const renew = { event: "charge.success", data: { id: 9102, reference: "ref-s2", status: "success", amount: 450000, currency: "NGN", plan: { plan_code: "PLN_starter" }, customer: { customer_code: "CUS_1" } } };
    expect((await paystack(renew)).body.outcome).toBe("renewed");
    expect((await paystack({ event: "subscription.not_renew", data: { id: 56, subscription_code: "SUB_1" } })).body.outcome).toBe("cancelled");
    expect(await plan(u.orgId)).toBe("starter"); // kept until the paid period ends
    await env.DB.prepare("UPDATE subscription SET current_period_end = ? WHERE org_id = ?").bind(Date.now() - 1000, u.orgId).run();
    expect(await expireSubscriptions(createDb(env.DB))).toBeGreaterThanOrEqual(1);
    expect(await plan(u.orgId)).toBe("free");
  });
});

describe("Lemon Squeezy", () => {
  it("applies subscriptions, refuses a second active one, and grants credit orders", async () => {
    const u = await user("p6ls1@example.com");
    const sub = (id: string, variant: string, item: string, status = "active") => ({
      meta: { event_name: "subscription_created", custom_data: null as unknown },
      data: { id, attributes: { status, variant_id: variant, customer_id: 7, renews_at: new Date(Date.now() + 365 * 86_400_000).toISOString(), updated_at: `${id}-1` } },
      item,
    });
    const a = sub("s-1", "111", "creator:year");
    a.meta.custom_data = await custom(u.orgId, a.item);
    expect((await lemon(a)).body.outcome).toBe("active");
    expect(await plan(u.orgId)).toBe("creator");

    const b = sub("s-2", "333", "starter:month");
    b.meta.custom_data = await custom(u.orgId, b.item);
    expect((await lemon(b)).body.outcome).toBe("conflict");
    expect(await plan(u.orgId)).toBe("creator");

    // A variant that doesn't match the signed checkout item is refused.
    const c = sub("s-3", "333", "creator:year");
    c.meta.custom_data = await custom(u.orgId, c.item);
    expect((await lemon(c)).body.outcome).toBe("unknown_item");

    const start = await balance(u);
    const order = { meta: { event_name: "order_created", custom_data: await custom(u.orgId, "credits:c500") }, data: { id: "o-1", attributes: { status: "paid", first_order_item: { variant_id: 222 }, updated_at: "x" } } };
    expect((await lemon(order)).body.outcome).toBe("credits_granted");
    expect((await lemon(order)).body.outcome).toBe("duplicate");
    expect(await balance(u)).toBe(start + 500);
  });
});

describe("checkout", () => {
  it("builds a signed Paystack checkout in NGN and never sells Lite through Lemon Squeezy", async () => {
    let sent: { url: string; body: Record<string, unknown> } | null = null;
    const cfg: BillingConfig = {
      signingSecret: "s",
      returnUrl: `${BASE}/app/settings`,
      paystack: { secretKey: "sk", plans: { "starter:month": "PLN_s" }, ngnPerUsd: 1500 },
      lemonsqueezy: { apiKey: "k", storeId: "1", webhookSecret: "w", variants: { "lite:month": "9" } },
      fetch: async (url, init) => {
        sent = { url, body: JSON.parse(String(init?.body)) };
        return Response.json({ status: true, data: { authorization_url: "https://checkout.paystack.com/x" } });
      },
    };
    const url = await createCheckout(cfg, { orgId: "org_1", email: "a@example.com", provider: "paystack", item: { kind: "plan", plan: "starter", interval: "month" } });
    expect(url).toBe("https://checkout.paystack.com/x");
    expect(sent!.body).toMatchObject({ currency: "NGN", amount: 450000, plan: "PLN_s", metadata: { org_id: "org_1", item: "starter:month" } });
    await expect(createCheckout(cfg, { orgId: "org_1", email: "a@example.com", provider: "lemonsqueezy", item: { kind: "plan", plan: "lite", interval: "month" } })).rejects.toThrow(/isn't set up/);
  });

  it("only owners and admins, in the app, and never over an active subscription", async () => {
    const u = await user("p6co1@example.com");
    const billing = (await (await u.call("GET", "/billing")).json()) as { catalog: { item: { kind: string; plan?: string }; providers: string[] }[] };
    expect(billing.catalog.find((c) => c.item.plan === "lite")!.providers).toEqual(["paystack"]);
    const first = { event: "charge.success", data: { id: 9201, reference: "ref-c1", status: "success", amount: 450000, currency: "NGN", plan: { plan_code: "PLN_starter" }, customer: { customer_code: "CUS_9" }, metadata: await custom(u.orgId, "starter:month") } };
    await paystack(first);
    expect((await u.call("POST", "/billing/checkout", { provider: "paystack", item: { kind: "plan", plan: "starter", interval: "month" } })).status).toBe(409);
    await env.DB.prepare("UPDATE membership SET role = 'editor' WHERE org_id = ?").bind(u.orgId).run();
    expect((await u.call("POST", "/billing/checkout", { provider: "paystack", item: { kind: "credits", pack: "c500" } })).status).toBe(403);
  });
});

describe("plan entitlements", () => {
  it("free plans keep autopilot to ideas and have no AI audience themes", async () => {
    const u = await user("p6ent@example.com");
    await u.call("PUT", "/persona", { displayName: "A", platforms: ["bluesky"] });
    expect((await u.call("PUT", "/autopilot", { level: "drafts", mode: "teach", platforms: ["bluesky"], postsPerWeek: 3, publishHourUtc: 14 })).status).toBe(402);
    expect((await u.call("POST", "/insights/refresh")).status).toBe(402);
    await env.DB.prepare("UPDATE org SET plan = 'starter' WHERE id = ?").bind(u.orgId).run();
    expect((await u.call("PUT", "/autopilot", { level: "batch", mode: "teach", platforms: ["bluesky"], postsPerWeek: 3, publishHourUtc: 14 })).status).toBe(200);
    expect((await u.call("PUT", "/autopilot", { level: "autopilot", mode: "teach", platforms: ["bluesky"], postsPerWeek: 3, publishHourUtc: 14 })).status).toBe(402);
  });
});

describe("team", () => {
  it("invites within seats, binds the invite to one verified email, and switches workspaces", async () => {
    const owner = await user("p6own@example.com");
    expect((await owner.call("POST", "/team/invites", { email: "p6mem@example.com", role: "editor" })).status).toBe(402); // free: 1 seat
    await env.DB.prepare("UPDATE org SET plan = 'pro' WHERE id = ?").bind(owner.orgId).run();
    expect((await owner.call("POST", "/team/invites", { email: "p6mem@example.com", role: "editor" })).status).toBe(402); // Pro: one person
    await env.DB.prepare("UPDATE org SET plan = 'team' WHERE id = ?").bind(owner.orgId).run();
    const inv = await owner.call("POST", "/team/invites", { email: "P6mem@example.com", role: "editor" });
    expect(inv.status).toBe(201);
    const { link } = (await inv.json()) as { link: string };
    const token = new URL(link).searchParams.get("token")!;
    expect((await owner.call("POST", "/team/invites", { email: "p6mem@example.com", role: "viewer" })).status).toBe(409);

    const other = await user("p6oth@example.com");
    await env.DB.prepare("UPDATE user SET email_verified = 1 WHERE id = ?").bind(other.userId).run();
    expect((await other.call("POST", "/team-invites/accept", { token })).status).toBe(409); // wrong email

    const member = await user("p6mem@example.com");
    expect((await member.call("POST", "/team-invites/accept", { token })).status).toBe(409); // email not verified
    await env.DB.prepare("UPDATE user SET email_verified = 1 WHERE id = ?").bind(member.userId).run();
    expect((await member.call("POST", "/team-invites/accept", { token })).status).toBe(200);
    expect((await member.call("POST", "/team-invites/accept", { token })).status).toBe(400); // used

    const ws = (await (await member.call("GET", "/workspaces")).json()) as { data: { id: string; role: string }[] };
    expect(ws.data.map((w) => w.role).sort()).toEqual(["editor", "owner"]);
    const inTeam = { "X-Org-Id": owner.orgId };
    expect(((await (await member.call("GET", "/me", undefined, inTeam)).json()) as { workspace: { id: string } }).workspace.id).toBe(owner.orgId);
    expect((await member.call("PUT", "/autopilot", { level: "coach", mode: "teach", platforms: [], postsPerWeek: 3, publishHourUtc: 14 }, inTeam)).status).toBe(403);
    expect((await other.call("GET", "/me", undefined, inTeam)).status).toBe(403);
  });

  it("protects owners and personal workspaces", async () => {
    const owner = await user("p6own2@example.com", "team");
    const team = (await (await owner.call("GET", "/team")).json()) as { members: { id: string; role: string }[] };
    const me = team.members[0]!;
    expect((await owner.call("PATCH", `/team/members/${me.id}`, { role: "admin" })).status).toBe(409); // last owner
    expect((await owner.call("DELETE", `/team/members/${me.id}`)).status).toBe(409);

    const { link } = (await (await owner.call("POST", "/team/invites", { email: "p6adm@example.com", role: "admin" })).json()) as { link: string };
    const admin = await user("p6adm@example.com");
    await env.DB.prepare("UPDATE user SET email_verified = 1 WHERE id = ?").bind(admin.userId).run();
    await admin.call("POST", "/team-invites/accept", { token: new URL(link).searchParams.get("token") });
    const inTeam = { "X-Org-Id": owner.orgId };
    expect((await admin.call("PATCH", `/team/members/${me.id}`, { role: "viewer" }, inTeam)).status).toBe(403);
    expect((await admin.call("POST", "/team/invites", { email: "x@example.com", role: "owner" }, inTeam)).status).toBe(403);
    const audit = (await (await owner.call("GET", "/audit")).json()) as { data: { action: string }[] };
    expect(audit.data.map((a) => a.action)).toEqual(expect.arrayContaining(["member.invited", "member.joined"]));
  });

  it("lets only the invited email sign up without the allowlist", async () => {
    const owner = await user("p6own3@example.com", "team");
    const { link } = (await (await owner.call("POST", "/team/invites", { email: "newcomer@outside.test", role: "viewer" })).json()) as { link: string };
    const token = new URL(link).searchParams.get("token")!;
    const preview = await SELF.fetch(`${BASE}/api/v1/team-invites/preview`, { method: "POST", headers: { "Content-Type": "application/json", ...ORIGIN, "CF-Connecting-IP": ip() }, body: JSON.stringify({ token }) });
    expect(((await preview.json()) as { workspace: string; emailHint: string }).emailHint).toBe("ne…@outside.test");
    const cookie = preview.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect((await signUp("intruder@outside.test", cookie)).ok).toBe(false);
    expect((await signUp("newcomer@outside.test", cookie)).ok).toBe(true);
  });
});

describe("audit and admin", () => {
  it("audit log is for owners and admins of that workspace", async () => {
    const a = await user("p6aud@example.com");
    const b = await user("p6aud2@example.com");
    expect((await a.call("GET", "/audit")).status).toBe(200);
    const theirs = (await (await b.call("GET", "/audit")).json()) as { data: { target: string | null }[] };
    expect(theirs.data.length).toBeGreaterThan(0);
    expect(theirs.data.some((x) => x.target === a.orgId)).toBe(false); // only b's own workspace events
    await env.DB.prepare("UPDATE membership SET role = 'editor' WHERE org_id = ?").bind(a.orgId).run();
    expect((await a.call("GET", "/audit")).status).toBe(403);
  });
  it("only platform admins comp plans, and it's audited", async () => {
    const u = await user("p6comp@example.com");
    expect((await u.call("PUT", `/admin/orgs/${u.orgId}/plan`, { plan: "pro", note: "beta tester" })).status).toBe(403);
    const admin = await user("admin@example.com");
    const found = (await (await admin.call("GET", "/admin/orgs?email=p6comp@example.com")).json()) as { data: { id: string }[] };
    expect(found.data[0]!.id).toBe(u.orgId);
    expect((await admin.call("PUT", `/admin/orgs/${u.orgId}/plan`, { plan: "pro", note: "beta tester" })).status).toBe(204);
    expect(await plan(u.orgId)).toBe("pro");
    const audit = (await (await u.call("GET", "/audit")).json()) as { data: { action: string }[] };
    expect(audit.data[0]!.action).toBe("plan.changed");
  });
});

describe("MCP server", () => {
  async function key(u: Awaited<ReturnType<typeof user>>) {
    return ((await (await u.call("POST", "/api-keys", { name: "agent" })).json()) as { key: string }).key;
  }
  const rpc = (k: string | null, body: unknown) =>
    SELF.fetch(`${BASE}/api/mcp`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip(), ...(k ? { Authorization: `Bearer ${k}` } : {}) }, body: JSON.stringify(body) });

  it("needs an API key and speaks JSON-RPC", async () => {
    expect((await rpc(null, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    const u = await user("p6mcp@example.com");
    const k = await key(u);
    const init = (await (await rpc(k, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })).json()) as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect((await rpc(k, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const list = (await (await rpc(k, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as { result: { tools: { name: string; inputSchema: { type: string } }[] } };
    expect(list.result.tools.map((t) => t.name)).toContain("compose_posts");
    expect(list.result.tools[0]!.inputSchema.type).toBe("object");
    expect(((await (await rpc(k, { jsonrpc: "2.0", id: 3, method: "nope" })).json()) as { error: { code: number } }).error.code).toBe(-32601);
    expect((await SELF.fetch(`${BASE}/api/mcp`, { method: "GET" })).status).toBe(405);
  });

  it("adds material, writes drafts and approves one, inside its own workspace only", async () => {
    const u = await user("p6mcp2@example.com");
    await u.call("PUT", "/persona", { displayName: "A", platforms: ["bluesky"] });
    const k = await key(u);
    const call = async (name: string, args: unknown) => ((await (await rpc(k, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).json()) as { result: { structuredContent: Record<string, unknown>; isError?: boolean; content: { text: string }[] } }).result;
    expect((await call("add_context", { text: "short" })).isError).toBe(true);
    const ctx = (await call("add_context", { text: "We shipped retries with exponential backoff today." })).structuredContent as { contextId: string };
    const out = (await call("compose_posts", { context_id: ctx.contextId, platforms: ["bluesky"] })).structuredContent as { drafts: { id: string }[] };
    expect(out.drafts).toHaveLength(1);
    expect(((await call("update_draft", { draft_id: out.drafts[0]!.id, status: "approved" })).structuredContent as { status: string }).status).toBe("approved");

    const stranger = await user("p6mcp3@example.com");
    const k2 = await key(stranger);
    const res = (await (await rpc(k2, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_draft", arguments: { draft_id: out.drafts[0]!.id, status: "discarded" } } })).json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0]!.text).toMatch(/No such draft/);
  });
});

describe("phase 6 review fixes", () => {
  it("ignores late, older Lemon Squeezy events", async () => {
    const u = await user("p6late@example.com");
    const ev = async (status: string, updatedAt: string) => ({
      meta: { event_name: "subscription_updated", custom_data: await custom(u.orgId, "creator:year") },
      data: { id: "s-late", attributes: { status, variant_id: "111", customer_id: 7, renews_at: new Date(Date.now() + 86_400_000).toISOString(), updated_at: updatedAt } },
    });
    expect((await lemon(await ev("cancelled", "2026-09-27T10:00:00Z"))).body.outcome).toBe("cancelled");
    expect((await lemon(await ev("active", "2026-09-27T09:00:00Z"))).body.outcome).toBe("stale");
    expect((await env.DB.prepare("SELECT status FROM subscription WHERE org_id = ?").bind(u.orgId).first<{ status: string }>())!.status).toBe("cancelled");
  });

  it("renews by subscription code, never guessing between workspaces", async () => {
    const a = await user("p6ren1@example.com");
    const b = await user("p6ren2@example.com");
    for (const [u, ref] of [[a, "ra"], [b, "rb"]] as const) {
      await paystack({ event: "charge.success", data: { id: `c-${ref}`, reference: ref, status: "success", amount: 450000, currency: "NGN", plan: { plan_code: "PLN_starter" }, customer: { customer_code: "CUS_SAME" }, metadata: await custom(u.orgId, "starter:month") } });
    }
    const renew = { event: "charge.success", data: { id: "c-renew", reference: "r-renew", status: "success", amount: 450000, currency: "NGN", plan: { plan_code: "PLN_starter" }, customer: { customer_code: "CUS_SAME" } } };
    expect((await paystack(renew)).body.outcome).toBe("ambiguous_renewal");
    await paystack({ event: "subscription.create", data: { id: 77, subscription_code: "SUB_A", plan: { plan_code: "PLN_starter" }, customer: { customer_code: "CUS_SAME" } } });
    expect((await paystack({ event: "invoice.update", data: { id: 78, paid: true, subscription: { subscription_code: "SUB_A", next_payment_date: "2027-01-01T00:00:00Z" } } })).body.outcome).toBe("renewed");
  });

  it("reverses refunded credit packs (partly, if already spent)", async () => {
    const u = await user("p6refund@example.com");
    const start = await balance(u);
    const order = { meta: { event_name: "order_created", custom_data: await custom(u.orgId, "credits:c500") }, data: { id: "o-ref", attributes: { status: "paid", first_order_item: { variant_id: 222 }, updated_at: "1" } } };
    await lemon(order);
    await env.DB.prepare("INSERT INTO credit_txn (id, org_id, kind, idempotency_key, description) VALUES ('txn_sp', ?, 'spend', 'sp', 't')").bind(u.orgId).run();
    await env.DB.prepare("INSERT INTO credit_entry (id, txn_id, org_id, account, amount) VALUES ('sp1','txn_sp',?,'org',-100),('sp2','txn_sp',?,'platform',100)").bind(u.orgId, u.orgId).run();
    const refund = { ...order, meta: { ...order.meta, event_name: "order_refunded" }, data: { ...order.data, attributes: { ...order.data.attributes, updated_at: "2" } } };
    expect((await lemon(refund)).body.outcome).toBe(start >= 100 ? "credits_reversed" : "partial_reversal");
    expect(await balance(u)).toBe(Math.max(0, start - 100));
  });

  it("revokes the API keys of removed members", async () => {
    const owner = await user("p6keys@example.com", "team");
    const { link } = (await (await owner.call("POST", "/team/invites", { email: "p6keysadm@example.com", role: "admin" })).json()) as { link: string };
    const admin = await user("p6keysadm@example.com");
    await env.DB.prepare("UPDATE user SET email_verified = 1 WHERE id = ?").bind(admin.userId).run();
    await admin.call("POST", "/team-invites/accept", { token: new URL(link).searchParams.get("token") });
    const inTeam = { "X-Org-Id": owner.orgId };
    const { key } = (await (await admin.call("POST", "/api-keys", { name: "admin's key" }, inTeam)).json()) as { key: string };
    const me = () => SELF.fetch(`${BASE}/api/v1/me`, { headers: { Authorization: `Bearer ${key}`, "CF-Connecting-IP": ip() } });
    expect((await me()).status).toBe(200);
    const team = (await (await owner.call("GET", "/team")).json()) as { members: { id: string; email: string }[] };
    const m = team.members.find((x) => x.email === "p6keysadm@example.com")!;
    expect((await owner.call("DELETE", `/team/members/${m.id}`)).status).toBe(204);
    expect((await me()).status).toBe(401);
  });
});
