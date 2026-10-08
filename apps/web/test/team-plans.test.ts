import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createCheckout, limitsFor, parsePlanKey, planPriceCents, seatsFor, signCustom, type BillingConfig } from "@nextrium/core";

// Team plans (owner decision 2026-10-08): every plan is one person, except
// - Team (shared): Pro's price and allowance, up to 5 people;
// - Team (per member): $8 a member a month, 2-5 members, each adding a Pro-sized allowance.
const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.46.${Math.floor(++n / 250)}.${n % 250}`;
const e = env as unknown as Record<string, string>;

async function user(email: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() },
    body: JSON.stringify({ email, name: "T", password: "correct-horse-battery" }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = (method: string, path: string, body?: unknown) =>
    SELF.fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string } };
  return { call, orgId: me.workspace.id };
}
async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function lemon(event: unknown) {
  const raw = JSON.stringify(event);
  const res = await SELF.fetch(`${BASE}/api/v1/webhooks/lemonsqueezy`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip(), "X-Signature": await hmac(e.LEMONSQUEEZY_WEBHOOK_SECRET!, raw) }, body: raw });
  return (await res.json()) as { outcome?: string };
}
const subEvent = async (orgId: string, id: string, variant: string, item: string) => ({
  meta: { event_name: "subscription_created", custom_data: await signCustom(e.BETTER_AUTH_SECRET!, orgId, item) },
  data: { id, attributes: { status: "active", variant_id: variant, customer_id: 9, renews_at: new Date(Date.now() + 31 * 86_400_000).toISOString(), updated_at: new Date().toISOString() } },
});
const invite = (u: Awaited<ReturnType<typeof user>>, email: string) => u.call("POST", "/team/invites", { email, role: "editor" });

describe("plan rules", () => {
  it("prices, seats and allowances", () => {
    expect(planPriceCents("team", "month")).toBe(planPriceCents("pro", "month")); // shared Team = Pro's price
    expect(limitsFor("team")).toEqual(limitsFor("pro"));
    expect(seatsFor("team")).toBe(5);
    expect(seatsFor("pro")).toBe(1);
    expect(seatsFor("creator")).toBe(1);
    expect(planPriceCents("team_seats", "month", 3)).toBe(2400);
    expect(planPriceCents("team_seats", "year", 2)).toBe(16000);
    expect(planPriceCents("team_seats", "month", 1)).toBeNull();
    expect(planPriceCents("team_seats", "month", 6)).toBeNull();
    expect(limitsFor("team_seats", 3)).toMatchObject({ posts: 1800, xApiPosts: 150, videos: 180, sources: 9, research: 180 });
    expect(seatsFor("team_seats", 4)).toBe(4);
    expect(parsePlanKey("team_seats:month:3")).toEqual({ plan: "team_seats", interval: "month", seats: 3 });
    expect(parsePlanKey("team_seats:month:9")).toBeNull();
    expect(parsePlanKey("pro:month:3")).toBeNull();
    expect(parsePlanKey("team:year")).toEqual({ plan: "team", interval: "year" });
  });

  it("a Team checkout is per member in naira", async () => {
    let sent: Record<string, unknown> | null = null;
    const cfg: BillingConfig = {
      signingSecret: "s",
      returnUrl: `${BASE}/app/billing`,
      paystack: { secretKey: "sk", plans: { "team_seats:month:3": "PLN_t3" }, ngnPerUsd: 1500 },
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return Response.json({ status: true, data: { authorization_url: "https://checkout.paystack.com/t" } });
      },
    };
    await createCheckout(cfg, { orgId: "org_t", email: "a@example.com", provider: "paystack", item: { kind: "plan", plan: "team_seats", interval: "month", seats: 3 } });
    expect(sent).toMatchObject({ currency: "NGN", amount: 3 * 800 * 1500, plan: "PLN_t3", metadata: { item: "team_seats:month:3" } });
    await expect(createCheckout(cfg, { orgId: "org_t", email: "a@example.com", provider: "paystack", item: { kind: "plan", plan: "team_seats", interval: "month" } })).rejects.toThrow(/Choose 2 to 5 members/);
  });
});

describe("seats in a workspace", () => {
  it("Pro is one person; Team (shared) takes up to 5, open invitations included", async () => {
    const u = await user("tp-shared@example.com");
    await env.DB.prepare("UPDATE org SET plan = 'pro' WHERE id = ?").bind(u.orgId).run();
    const refused = await invite(u, "tp-a@example.com");
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(/Team plan/);
    await env.DB.prepare("UPDATE org SET plan = 'team' WHERE id = ?").bind(u.orgId).run();
    for (const x of ["b", "c", "d", "e"]) expect((await invite(u, `tp-${x}@example.com`)).status).toBe(201);
    expect((await invite(u, "tp-f@example.com")).status).toBe(402); // 1 owner + 4 invited = 5
    const team = (await (await u.call("GET", "/team")).json()) as { seats: number };
    expect(team.seats).toBe(5);
  });

  it("per-member Team: bought for 3 through the webhook, allowance times 3, and 3 people at most", async () => {
    const u = await user("tp-seats@example.com");
    expect(await lemon(await subEvent(u.orgId, "ts-1", "555", "team_seats:month:3"))).toEqual({ ok: true, outcome: "active" });
    expect(await env.DB.prepare("SELECT plan, seats FROM org WHERE id = ?").bind(u.orgId).first()).toEqual({ plan: "team_seats", seats: 3 });
    const usage = (await (await u.call("GET", "/usage")).json()) as { posts: { limit: number }; videos: { limit: number }; sources: { limit: number } };
    expect(usage).toMatchObject({ posts: { limit: 1800 }, videos: { limit: 180 }, sources: { limit: 9 } });
    const billing = (await (await u.call("GET", "/billing")).json()) as { features: { seats: number }; subscription: { seats: number } };
    expect(billing.features.seats).toBe(3);
    expect(billing.subscription.seats).toBe(3);
    expect((await invite(u, "tp-s1@example.com")).status).toBe(201);
    expect((await invite(u, "tp-s2@example.com")).status).toBe(201);
    const full = await invite(u, "tp-s3@example.com");
    expect(full.status).toBe(402);
    expect(((await full.json()) as { error: { message: string } }).error.message).toMatch(/paid for 3 members/);
  });

  it("removing someone frees their seat for someone new, but not this month's usage", async () => {
    const u = await user("tp-churn@example.com");
    await env.DB.prepare("UPDATE org SET plan = 'team' WHERE id = ?").bind(u.orgId).run();
    const period = new Date().toISOString().slice(0, 7);
    await env.DB.prepare("INSERT INTO usage_counter (org_id, period, posts_generated) VALUES (?, ?, 600)").bind(u.orgId, period).run();
    const inv = (await (await invite(u, "tp-gone@example.com")).json()) as { id: string };
    expect((await u.call("DELETE", `/team/invites/${inv.id}`)).status).toBeLessThan(300);
    expect((await invite(u, "tp-new@example.com")).status).toBe(201);
    const usage = (await (await u.call("GET", "/usage")).json()) as { posts: { used: number; limit: number } };
    expect(usage.posts).toEqual({ used: 600, limit: 600 }); // still used up: usage is the workspace's, for the month
  });

  it("the catalog offers both Team plans, per-member Team for 2 to 5", async () => {
    const u = await user("tp-catalog@example.com");
    const billing = (await (await u.call("GET", "/billing")).json()) as { catalog: { item: { kind: string; plan?: string; interval?: string; seats?: number }; usdCents: number; providers: string[] }[] };
    const team = billing.catalog.find((c) => c.item.plan === "team" && c.item.interval === "month")!;
    expect(team.usdCents).toBe(1000);
    expect(team.providers).toEqual(["lemonsqueezy"]);
    const seats = billing.catalog.filter((c) => c.item.plan === "team_seats" && c.item.interval === "month");
    expect(seats.map((c) => [c.item.seats, c.usdCents])).toEqual([[2, 1600], [3, 2400], [4, 3200], [5, 4000]]);
    expect(seats.find((c) => c.item.seats === 3)!.providers).toEqual(["lemonsqueezy"]); // only the configured ones can be bought
    expect(seats.find((c) => c.item.seats === 2)!.providers).toEqual([]);
  });
});
