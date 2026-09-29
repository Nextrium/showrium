import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb } from "@nextrium/db";
import { createIdeas, importTokenKey, nextSlot, pickMode, runAutopilotFor, runSourcePolling, saveConnection, type PublishDeps } from "@nextrium/core";
import { fakeProvider } from "@nextrium/llm";

const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.16.${Math.floor(++n / 250)}.${n % 250}`;

async function user(email: string, plan = "creator", platforms = ["bluesky", "linkedin", "x"]) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() },
    body: JSON.stringify({ email, name: "S3", password: "correct-horse-battery" }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = (method: string, path: string, body?: unknown) =>
    SELF.fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  await call("PUT", "/persona", { displayName: "S", platforms });
  const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string } };
  await env.DB.prepare("UPDATE org SET plan = ? WHERE id = ?").bind(plan, me.workspace.id).run();
  const row = await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>();
  return { call, orgId: me.workspace.id, userId: row!.id };
}

const off = { write: false, schedule: false, approve: false };
const settings = (over: Record<string, unknown> = {}) => ({ findIdeas: true, rules: {}, mix: { build_in_public: 2, teach: 1 }, days: [1, 3, 5], publishHourUtc: 9, ...over });
const reply = (user: string) => {
  const ids = (user.match(/Platform ids: ([^.]+)\./)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return JSON.stringify({ angle: "a", key_points: ["k"], variants: ids.map((platform) => ({ platform, text: `Shipped retries today on ${platform}.` })) });
};
async function connectBluesky(u: Awaited<ReturnType<typeof user>>) {
  const d: PublishDeps = { db: createDb(env.DB), key: await importTokenKey(env.TOKEN_ENCRYPTION_KEY), configs: { mastodonRedirectUri: `${BASE}/cb` } };
  await saveConnection(d, { orgId: u.orgId, platform: "bluesky", account: { accountId: "did:plc:s3", handle: "@s3" }, secret: { identifier: "s3", appPassword: "aaaa-bbbb-cccc-dddd" }, meta: {}, userId: u.userId });
}

describe("automation switches", () => {
  it("saves independent switches per platform, a style mix and days", async () => {
    const u = await user("s3-save@example.com");
    const res = await u.call("PUT", "/autopilot", settings({ rules: { bluesky: { write: true, schedule: true, approve: true }, linkedin: { write: true, schedule: false, approve: false }, x: { ...off, schedule: true } } }));
    expect(res.status).toBe(200);
    const s = (await (await u.call("GET", "/autopilot")).json()) as { rules: Record<string, unknown>; mix: Record<string, number>; days: number[]; level: string; postsPerWeek: number };
    expect(s.rules).toEqual({ bluesky: { write: true, schedule: true, approve: true }, linkedin: { write: true, schedule: false, approve: false }, x: { write: false, schedule: true, approve: false } });
    expect(s).toMatchObject({ mix: { build_in_public: 2, teach: 1 }, days: [1, 3, 5], level: "autopilot", postsPerWeek: 3 });
  });

  it("gates switches by plan, X and monetization-safe mode", async () => {
    const free = await user("s3-free@example.com", "free");
    expect((await free.call("PUT", "/autopilot", settings({ findIdeas: false }))).status).toBe(200); // ideas-only is free
    expect((await free.call("PUT", "/autopilot", settings({ rules: { bluesky: { ...off, write: true } } }))).status).toBe(402);
    const starter = await user("s3-starter@example.com", "starter");
    expect((await starter.call("PUT", "/autopilot", settings({ rules: { bluesky: { write: true, schedule: true, approve: false } } }))).status).toBe(200);
    expect((await starter.call("PUT", "/autopilot", settings({ rules: { bluesky: { write: true, schedule: true, approve: true } } }))).status).toBe(402);
    const c = await user("s3-creator@example.com");
    expect((await c.call("PUT", "/autopilot", settings({ rules: { x: { write: true, schedule: true, approve: true } } }))).status).toBe(409);
    expect((await c.call("PUT", "/autopilot", settings({ rules: { instagram: { ...off, write: true } } }))).status).toBe(409); // not in their platforms
    expect((await c.call("PUT", "/autopilot", settings({ mix: { teach: 8, smile: 7 }, rules: { bluesky: { ...off, write: true } } }))).status).toBe(409); // 15 a week
    expect((await c.call("PUT", "/autopilot", settings({ days: [] }))).status).toBe(400);
    await env.DB.prepare("UPDATE persona SET monetization_safe = 1 WHERE org_id = ?").bind(c.orgId).run();
    expect((await c.call("PUT", "/autopilot", settings({ rules: { bluesky: { write: true, schedule: true, approve: true } } }))).status).toBe(409);
    expect((await c.call("PUT", "/autopilot", settings({ rules: { bluesky: { write: true, schedule: true, approve: false } } }))).status).toBe(200);
  });

  it("follows the weekly mix, and posts only on the chosen days", () => {
    const now = new Date("2026-09-29T08:00:00Z"); // a Tuesday
    const mix = { build_in_public: 2, teach: 1 };
    expect(pickMode(mix, [], now)).toBe("build_in_public");
    const at = now.getTime() - 3600_000;
    expect(pickMode(mix, [{ at, mode: "build_in_public" }, { at, mode: "build_in_public" }], now)).toBe("teach");
    expect(pickMode(mix, [{ at, mode: "build_in_public" }, { at, mode: "build_in_public" }, { at, mode: "teach" }], now)).toBeNull();
    // Entries older than a week no longer count.
    expect(pickMode(mix, [{ at: now.getTime() - 8 * 86_400_000, mode: "teach" }], now)).toBe("build_in_public");
    expect(nextSlot(now, 9, [1, 3, 5]).toISOString()).toBe("2026-09-30T09:00:00.000Z"); // Wednesday
    expect(nextSlot(now, 9, [2]).toISOString()).toBe("2026-10-06T09:00:00.000Z"); // Tuesday 09:00 is under 2 hours away
  });

  it("schedules a post as soon as you approve it, in the next free slot", async () => {
    const u = await user("s3-sched@example.com");
    await connectBluesky(u);
    expect((await u.call("PUT", "/autopilot", settings({ rules: { bluesky: { ...off, schedule: true } } }))).status).toBe(200);
    const ctx = (await (await u.call("POST", "/contexts", { kind: "manual", body: "We shipped retries with backoff today." })).json()) as { id: string };
    const a = ((await (await u.call("POST", "/compose", { contextItemId: ctx.id, mode: "teach", platforms: ["bluesky", "linkedin"] })).json()) as { drafts: { id: string; platform: string }[] }).drafts;
    const b = ((await (await u.call("POST", "/compose", { contextItemId: ctx.id, mode: "smile", platforms: ["bluesky"] })).json()) as { drafts: { id: string }[] }).drafts;
    const bsky = a.find((d) => d.platform === "bluesky")!;
    const li = a.find((d) => d.platform === "linkedin")!;
    const first = (await (await u.call("PATCH", `/drafts/${bsky.id}`, { status: "approved" })).json()) as { draft: { status: string; scheduledAt: string } };
    expect(first.draft.status).toBe("scheduled");
    expect(new Date(first.draft.scheduledAt).toISOString()).toBe(nextSlot(new Date(), 9, [1, 3, 5]).toISOString());
    const second = (await (await u.call("POST", "/drafts/bulk-approve", { ids: [b[0]!.id] })).json()) as { approved: string[] };
    expect(second.approved).toHaveLength(1);
    const times = await env.DB.prepare("SELECT scheduled_at FROM draft WHERE org_id = ? AND status = 'scheduled' ORDER BY scheduled_at").bind(u.orgId).all<{ scheduled_at: number }>();
    expect(times.results).toHaveLength(2);
    expect(times.results[1]!.scheduled_at).toBeGreaterThan(times.results[0]!.scheduled_at); // not the same slot
    // LinkedIn has the switch off: approving leaves it approved.
    expect(((await (await u.call("PATCH", `/drafts/${li.id}`, { status: "approved" })).json()) as { draft: { status: string } }).draft.status).toBe("approved");
  });
});

describe("the automation run", () => {
  it("writes for platforms with writing on, approves only where allowed, and records the style", async () => {
    const u = await user("s3-run@example.com");
    await connectBluesky(u);
    await u.call("PUT", "/autopilot", settings({ mix: { teach: 3 }, rules: { bluesky: { write: true, schedule: true, approve: true }, linkedin: { ...off, write: true } } }));
    const cid = `ctx_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO context_item (id, org_id, kind, title, body) VALUES (?, ?, 'rss_item', 'How we test queues', 'A long article.')").bind(cid, u.orgId).run();
    await createIdeas(createDb(env.DB), u.orgId, "rss_item", [{ id: cid, title: "How we test queues" }]);
    const out = await runAutopilotFor(createDb(env.DB), [fakeProvider((r) => reply(r.user))], u.orgId);
    expect(out).toMatchObject({ mode: "teach", drafts: 2, approved: 1, scheduled: 1 });
    const rows = await env.DB.prepare("SELECT platform, status FROM draft WHERE org_id = ? ORDER BY platform").bind(u.orgId).all<{ platform: string; status: string }>();
    expect(rows.results).toEqual([{ platform: "bluesky", status: "scheduled" }, { platform: "linkedin", status: "draft" }]);
    const log = await env.DB.prepare("SELECT week_log FROM autopilot WHERE org_id = ?").bind(u.orgId).first<{ week_log: string }>();
    expect(JSON.parse(log!.week_log)).toHaveLength(1);
    // Right away again: too soon (the week is spread out).
    expect(await runAutopilotFor(createDb(env.DB), [fakeProvider((r) => reply(r.user))], u.orgId)).toEqual({ skipped: "spacing" });
  });

  it("reads settings saved before this change as switches", async () => {
    const u = await user("s3-legacy@example.com");
    await env.DB.prepare("INSERT INTO autopilot (org_id, level, mode, platforms, posts_per_week, publish_hour_utc) VALUES (?, 'autopilot', 'teach', '[\"bluesky\",\"x\"]', 4, 10)").bind(u.orgId).run();
    const s = (await (await u.call("GET", "/autopilot")).json()) as { rules: Record<string, { approve: boolean }>; mix: Record<string, number> };
    expect(s.rules.bluesky).toEqual({ write: true, schedule: true, approve: true });
    expect(s.rules.x).toEqual({ write: true, schedule: false, approve: false });
    expect(s.mix).toEqual({ teach: 4 });
  });

  it("\"find ideas\" off: sources aren't checked automatically", async () => {
    const u = await user("s3-find@example.com");
    const sid = `src_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO source (id, org_id, kind, key, last_checked_at) VALUES (?, ?, 'rss', 'https://s3.example/feed', 0)").bind(sid, u.orgId).run();
    await u.call("PUT", "/autopilot", settings({ findIdeas: false }));
    let fetched = false;
    await runSourcePolling(createDb(env.DB), { fetch: async () => ((fetched = true), new Response("<rss></rss>", { headers: { "Content-Type": "application/rss+xml" } })) }, new Date(), 500);
    expect(fetched).toBe(false);
    expect((await env.DB.prepare("SELECT last_checked_at FROM source WHERE id = ?").bind(sid).first<{ last_checked_at: number }>())!.last_checked_at).toBe(0);
  });
});
