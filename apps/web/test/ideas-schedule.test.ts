import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb } from "@nextrium/db";
import {
  autoScheduleApproved,
  autoScheduledEmails,
  baseScore,
  createIdeas,
  effectiveScore,
  importTokenKey,
  isApprovable,
  isStale,
  isWritable,
  listIdeas,
  parseFeed,
  publishDraft,
  rescoreOldIdeas,
  runAutopilotFor,
  sameStory,
  saveConnection,
  syncSource,
  type PublishDeps,
} from "@nextrium/core";
import { fakeProvider } from "@nextrium/llm";

// Owner feedback 2026-10-18: fresh, relevant ideas; no clashing schedules; a notice before automated
// posts go out (they're always scheduled ahead); X and passions may be approved by automation.
const BASE = "http://localhost:5173";
const DAY = 86_400_000;
let n = 0;
const ip = () => `10.51.${Math.floor(++n / 250)}.${n % 250}`;

async function user(email: string, plan = "creator", platforms = ["bluesky", "linkedin", "x"]) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() }, body: JSON.stringify({ email, name: "Ada Owner", password: "correct-horse-battery" }) });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = (method: string, path: string, body?: unknown) =>
    SELF.fetch(`${BASE}/api/v1${path}`, { method, headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  await call("PUT", "/persona", { displayName: "Ada", platforms, interests: ["queues"], expertise: ["typescript"] });
  const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string } };
  await env.DB.prepare("UPDATE org SET plan = ? WHERE id = ?").bind(plan, me.workspace.id).run();
  const row = await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>();
  return { call, orgId: me.workspace.id, userId: row!.id };
}
const deps = async (): Promise<PublishDeps> => ({ db: createDb(env.DB), key: await importTokenKey(env.TOKEN_ENCRYPTION_KEY), configs: { mastodonRedirectUri: `${BASE}/cb` } });
async function connect(u: Awaited<ReturnType<typeof user>>, platform: "bluesky" | "x") {
  const secret = platform === "bluesky" ? { identifier: "ada", appPassword: "aaaa-bbbb-cccc-dddd" } : { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + DAY };
  await saveConnection(await deps(), { orgId: u.orgId, platform, account: { accountId: `${platform}-ada`, handle: "@ada" }, secret, meta: {}, userId: u.userId });
  return (await env.DB.prepare("SELECT id FROM connection WHERE org_id = ? AND platform = ?").bind(u.orgId, platform).first<{ id: string }>())!.id;
}
/** An approved post on a platform (written straight into the database). */
async function approvedPost(orgId: string, platform: string, text = "A post about queues.") {
  const id = `drf_${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO draft (id, org_id, platform, text, status, issues) VALUES (?, ?, ?, ?, 'approved', '[]')").bind(id, orgId, platform, text).run();
  return id;
}
const settings = (over: Record<string, unknown> = {}) => ({ findIdeas: false, rules: {}, mix: { teach: 3 }, days: [0, 1, 2, 3, 4, 5, 6], publishHourUtc: 9, ...over });
const reply = (u: string) => {
  const ids = (u.match(/Platform ids: ([^.]+)\./)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return JSON.stringify({ angle: "a", key_points: ["k"], variants: ids.map((platform) => ({ platform, text: `Shipped retries today on ${platform}.` })) });
};

describe("idea scores", () => {
  it("rewards what matters and fresh material, and filters noise", () => {
    expect(baseScore({ kind: "github_release", title: "acme/app v2.0.0 released" })).toBe(80);
    expect(baseScore({ kind: "github_release", title: "acme/app v2.1.0-rc.1" })).toBe(40); // pre-release: even fresh (60), never auto-approved
    expect(effectiveScore(baseScore({ kind: "rss_item", title: "Weekly digest #42" }), 0)).toBeLessThan(40); // hidden even when fresh
    expect(baseScore({ kind: "rss_item", title: "How we scale queues in TypeScript", keywords: ["queues", "typescript"] })).toBe(55);
    // A passion's item that never mentions it is probably off-topic.
    expect(baseScore({ kind: "rss_item", title: "Bitcoin hits a new high", passionName: "Cardano" })).toBe(25);
    expect(baseScore({ kind: "rss_item", title: "Cardano node 10.2 is out", passionName: "Cardano" })).toBe(55);
    // Days of only chores.
    expect(baseScore({ kind: "github_activity", title: "3 commits on acme/app", body: "Work:\n- Bump vite\n- chore: lint\n- Fix typo" })).toBe(30);
    expect(effectiveScore(55, 0.5 * DAY)).toBe(75);
    expect(effectiveScore(55, 10 * DAY)).toBe(25);
    expect(isStale(15 * DAY, "outside")).toBe(true);
    expect(isStale(15 * DAY, "own")).toBe(false);
    expect(isWritable(65, 4 * DAY, "outside")).toBe(false);
    expect(isWritable(65, 4 * DAY, "own")).toBe(true);
    expect(isApprovable(75, DAY)).toBe(true);
    expect(isApprovable(75, 3 * DAY)).toBe(false);
    expect(sameStory("Cardano node 10.2 released with faster sync", "Faster sync: Cardano node 10.2 released")).toBe(true);
    expect(sameStory("Cardano node 10.2 released", "Ethereum upgrade delayed again")).toBe(false);
  });

  it("reads publish dates, and skips old items (a first check brings at most 3)", async () => {
    const now = Date.now();
    const item = (i: number, daysAgo: number) => `<item><title>Post ${i} about something different number ${i}</title><guid>g${i}</guid><pubDate>${new Date(now - daysAgo * DAY).toUTCString()}</pubDate><description>Body ${i}</description></item>`;
    const xml = `<rss><channel>${[item(1, 1), item(2, 2), item(3, 3), item(4, 4), item(5, 40)].join("")}</channel></rss>`;
    expect(parseFeed(xml)[0]!.publishedAt).toBeInstanceOf(Date);
    const u = await user("is-fresh@example.com");
    const id = `src_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO source (id, org_id, kind, key) VALUES (?, ?, 'rss', 'https://ex.org/feed')").bind(id, u.orgId).run();
    const src = { id, orgId: u.orgId, kind: "rss" as const, key: "https://ex.org/feed", passionId: null, seen: [], lastCheckedAt: null, lastError: null, createdAt: new Date() };
    const fetchFeed = async () => new Response(xml, { headers: { "Content-Type": "application/rss+xml" } });
    expect((await syncSource(createDb(env.DB), src, { fetch: fetchFeed })).added).toBe(3); // first check: newest 3
    expect((await syncSource(createDb(env.DB), { ...src, lastCheckedAt: new Date() }, { fetch: fetchFeed })).added).toBe(1); // then the 4-day-old one; never the 40-day-old one
  });

  it("the same story twice is one idea (scored higher); weak and stale ideas are tucked away", async () => {
    const u = await user("is-list@example.com");
    const db = createDb(env.DB);
    const ctx = async (title: string, daysAgo = 0) => {
      const id = `ctx_${crypto.randomUUID()}`;
      await env.DB.prepare("INSERT INTO context_item (id, org_id, kind, title, body, published_at) VALUES (?, ?, 'rss_item', ?, 'b', ?)").bind(id, u.orgId, title, Date.now() - daysAgo * DAY).run();
      return { id, title };
    };
    expect(await createIdeas(db, u.orgId, "rss_item", [await ctx("Queues in TypeScript: our new retry design")], undefined, { keywords: ["queues"] })).toBe(1);
    expect(await createIdeas(db, u.orgId, "rss_item", [await ctx("Our new retry design: queues in TypeScript")], undefined, { keywords: ["queues"] })).toBe(0);
    await createIdeas(db, u.orgId, "rss_item", [await ctx("Weekly digest #7 of links")]); // weak
    await createIdeas(db, u.orgId, "rss_item", [await ctx("An old story about something else entirely", 40)]); // stale
    const shown = await listIdeas(db, u.orgId);
    expect(shown.map((i) => i.title)).toEqual(["Queues in TypeScript: our new retry design"]);
    expect(shown[0]!.score).toBe(80); // 45 + 5 (queues) + 10 (seen twice) + 20 (today)
    const res = (await (await u.call("GET", "/ideas")).json()) as { data: unknown[]; counts: { new: number; hidden: number } };
    expect(res.counts).toMatchObject({ new: 1, hidden: 2 });
    expect(((await (await u.call("GET", "/ideas?all=true")).json()) as { data: unknown[] }).data).toHaveLength(3);
  });

  it("old ideas are re-scored under the new rules, and a day of GitHub work gets its date back", async () => {
    const u = await user("is-rescore@example.com");
    const ctx = `ctx_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO context_item (id, org_id, kind, title, body, external_id) VALUES (?, ?, 'github_activity', '3 commits on acme/app (2026-09-01)', 'Work:\n- Bump vite\n- chore: lint\n- Fix typo', 'gh-day:acme/app:2026-09-01')").bind(ctx, u.orgId).run();
    const id = `idea_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO idea (id, org_id, context_item_id, reason, score, score_version) VALUES (?, ?, ?, 'Your work', 90, 1)").bind(id, u.orgId, ctx).run();
    expect(await rescoreOldIdeas(createDb(env.DB), 500)).toBeGreaterThanOrEqual(1);
    const row = await env.DB.prepare("SELECT score, score_version FROM idea WHERE id = ?").bind(id).first<{ score: number; score_version: number }>();
    expect(row).toEqual({ score: 30, score_version: 2 }); // only chores
    const c = await env.DB.prepare("SELECT published_at FROM context_item WHERE id = ?").bind(ctx).first<{ published_at: number }>();
    expect(c?.published_at).toBe(Date.parse("2026-09-01T23:59:59Z"));
    expect(await listIdeas(createDb(env.DB), u.orgId)).toEqual([]); // weak and stale: tucked away
  });

  it("automation only writes from good, fresh ideas", async () => {
    const u = await user("is-auto@example.com");
    await u.call("PUT", "/autopilot", settings({ rules: { linkedin: { write: true, schedule: false, approve: false } } }));
    const id = `ctx_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO context_item (id, org_id, kind, title, body, published_at) VALUES (?, ?, 'rss_item', 'Thoughts on naming', 'b', ?)").bind(id, u.orgId, Date.now() - 2 * DAY).run();
    await createIdeas(createDb(env.DB), u.orgId, "rss_item", [{ id, title: "Thoughts on naming" }]); // 45 + 10 = 55: shown, not written from
    expect(await runAutopilotFor(createDb(env.DB), [fakeProvider((r) => reply(r.user))], u.orgId)).toEqual({ skipped: "no_ideas" });
  });
});

describe("scheduling clashes", () => {
  it("asks before scheduling near an automated post, and can move it (your post keeps its time)", async () => {
    const u = await user("is-clash@example.com");
    const conn = await connect(u, "bluesky");
    await u.call("PUT", "/autopilot", settings({ rules: { bluesky: { write: false, schedule: true, approve: false } } }));
    const auto = await approvedPost(u.orgId, "bluesky");
    expect(await autoScheduleApproved(createDb(env.DB), u.orgId, [auto])).toBe(1);
    const autoAt = (await env.DB.prepare("SELECT scheduled_at, auto_scheduled FROM draft WHERE id = ?").bind(auto).first<{ scheduled_at: number; auto_scheduled: number }>())!;
    expect(autoAt.auto_scheduled).toBe(1);
    const mine = await approvedPost(u.orgId, "bluesky", "My own news.");
    const at = new Date(autoAt.scheduled_at + 30 * 60_000).toISOString();
    const ask = await u.call("POST", `/drafts/${mine}/schedule`, { connectionId: conn, at });
    expect(ask.status).toBe(409);
    expect(((await ask.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "schedule_clash_auto", message: expect.stringContaining("picked by automation") });
    const moved = await u.call("POST", `/drafts/${mine}/schedule`, { connectionId: conn, at, onClash: "move" });
    expect(moved.status).toBe(200);
    const after = await env.DB.prepare("SELECT id, scheduled_at, status FROM draft WHERE id IN (?, ?)").bind(auto, mine).all<{ id: string; scheduled_at: number | null; status: string }>();
    const a = after.results.find((r) => r.id === auto)!;
    const m = after.results.find((r) => r.id === mine)!;
    expect(m.scheduled_at).toBe(Date.parse(at));
    // Moved at least 4 hours away, or back to approved if nothing was free (never posted unexpectedly).
    expect(a.status === "approved" || Math.abs(a.scheduled_at! - m.scheduled_at!) >= 4 * 3600_000).toBe(true);
  });

  it("two of your own posts: asked, then kept both if you say so", async () => {
    const u = await user("is-clash2@example.com");
    const conn = await connect(u, "bluesky");
    const one = await approvedPost(u.orgId, "bluesky", "One.");
    const two = await approvedPost(u.orgId, "bluesky", "Two.");
    const at = new Date(Date.now() + 3 * DAY).toISOString();
    expect((await u.call("POST", `/drafts/${one}/schedule`, { connectionId: conn, at })).status).toBe(200);
    const ask = await u.call("POST", `/drafts/${two}/schedule`, { connectionId: conn, at: new Date(Date.parse(at) + 3600_000).toISOString() });
    expect(((await ask.json()) as { error: { code: string } }).error.code).toBe("schedule_clash");
    expect((await u.call("POST", `/drafts/${two}/schedule`, { connectionId: conn, at: new Date(Date.parse(at) + 3600_000).toISOString(), onClash: "keep" })).status).toBe(200);
    // A different day is fine.
    const three = await approvedPost(u.orgId, "bluesky", "Three.");
    expect((await u.call("POST", `/drafts/${three}/schedule`, { connectionId: conn, at: new Date(Date.parse(at) + DAY).toISOString() })).status).toBe(200);
  });
});

describe("before automated posts go out", () => {
  it("emails the owners a list to check, unless switched off; cancelling puts the post back", async () => {
    const u = await user("is-notify@example.com");
    await env.DB.prepare("UPDATE user SET email_verified = 1 WHERE id = ?").bind(u.userId).run();
    await connect(u, "bluesky");
    await u.call("PUT", "/autopilot", settings({ timezone: "Africa/Lagos", rules: { bluesky: { write: false, schedule: true, approve: false } } }));
    const id = await approvedPost(u.orgId, "bluesky", "Retries with backoff are live for every background job.");
    await autoScheduleApproved(createDb(env.DB), u.orgId, [id]);
    const emails = await autoScheduledEmails(createDb(env.DB), u.orgId, [id], BASE);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ to: "is-notify@example.com", subject: "A post is scheduled: check it before it goes out" });
    expect(emails[0]!.text).toContain("Bluesky, ");
    expect(emails[0]!.text).toContain("Retries with backoff");
    expect(emails[0]!.text).toContain(`${BASE}/app/posts?status=scheduled`);
    expect(emails[0]!.text).toContain("(Africa/Lagos)");
    // Cancel: back to approved, no time, no longer automatic.
    const res = await u.call("PATCH", `/drafts/${id}`, { status: "approved" });
    expect(((await res.json()) as { draft: { status: string; scheduledAt: string | null; autoScheduled: boolean } }).draft).toMatchObject({ status: "approved", scheduledAt: null, autoScheduled: false });
    // Switched off: no email.
    const id2 = await approvedPost(u.orgId, "bluesky", "Another one.");
    await autoScheduleApproved(createDb(env.DB), u.orgId, [id2]);
    await u.call("PUT", "/autopilot", { ...settings({ timezone: "Africa/Lagos", rules: { bluesky: { write: false, schedule: true, approve: false } } }), notifyEmail: false });
    expect(await autoScheduledEmails(createDb(env.DB), u.orgId, [id2], BASE)).toEqual([]);
  });
});

describe("X: automation may approve, with consent and within the plan's X posts", () => {
  it("asks for consent once; switching X approval off clears it", async () => {
    const u = await user("is-xconsent@example.com");
    const rules = { x: { write: true, schedule: true, approve: true } };
    const no = await u.call("PUT", "/autopilot", settings({ rules }));
    expect(no.status).toBe(409);
    expect(((await no.json()) as { error: { code: string } }).error.code).toBe("x_consent_required");
    const yes = await u.call("PUT", "/autopilot", { ...settings({ rules }), xConsent: true });
    expect(yes.status).toBe(200);
    expect(((await yes.json()) as { xConsentAt: string | null }).xConsentAt).not.toBeNull();
    expect((await u.call("PUT", "/autopilot", settings({ rules }))).status).toBe(200); // not asked again
    const offAgain = (await (await u.call("PUT", "/autopilot", settings({ rules: { x: { write: true, schedule: true, approve: false } } }))).json()) as { xConsentAt: string | null };
    expect(offAgain.xConsentAt).toBeNull();
    expect((await u.call("PUT", "/autopilot", settings({ rules }))).status).toBe(409); // asked again
  });

  it("a run approves and schedules X posts with consent, and stops when the plan's X posts are taken", async () => {
    const u = await user("is-xrun@example.com");
    await connect(u, "x");
    const rules = { x: { write: true, schedule: true, approve: true } };
    expect((await u.call("PUT", "/autopilot", { ...settings({ rules }), xConsent: true })).status).toBe(200);
    const idea = async (title: string) => {
      const id = `ctx_${crypto.randomUUID()}`;
      await env.DB.prepare("INSERT INTO context_item (id, org_id, kind, title, body, published_at) VALUES (?, ?, 'manual', ?, 'b', ?)").bind(id, u.orgId, title, Date.now()).run();
      await createIdeas(createDb(env.DB), u.orgId, "manual", [{ id, title }]); // a fresh note of your own: 55 + 20 = 75
    };
    await idea("We shipped retries for every background job");
    const first = await runAutopilotFor(createDb(env.DB), [fakeProvider((r) => reply(r.user))], u.orgId);
    expect(first).toMatchObject({ drafts: 1, approved: 1, scheduled: 1 });
    // The plan's X posts are all used or already scheduled: written, but left for the person.
    const period = new Date().toISOString().slice(0, 7);
    await env.DB.prepare("INSERT INTO usage_counter (org_id, period, x_api_posts) VALUES (?, ?, 49) ON CONFLICT(org_id, period) DO UPDATE SET x_api_posts = 49").bind(u.orgId, period).run();
    await env.DB.prepare("UPDATE autopilot SET last_run_at = NULL, week_log = '[]' WHERE org_id = ?").bind(u.orgId).run();
    await env.DB.prepare("DELETE FROM draft WHERE org_id = ? AND status = 'draft'").bind(u.orgId).run();
    await idea("A completely different note about naming things well");
    const tomorrow = new Date(Date.now() + DAY);
    const second = await runAutopilotFor(createDb(env.DB), [fakeProvider((r) => reply(r.user))], u.orgId, tomorrow);
    expect(second).toMatchObject({ approved: 0 }); // 50 allowed: 49 used + 1 scheduled
  });

  it("a post automation approved never spends credits on X", async () => {
    const u = await user("is-xcredits@example.com", "starter");
    const conn = await connect(u, "x");
    await env.DB.prepare("INSERT INTO credit_txn (id, org_id, kind, amount, idempotency_key, description) VALUES (?, ?, 'grant', 100, ?, 'test')").bind(`txn_${crypto.randomUUID()}`, u.orgId, `grant:${u.orgId}`).run().catch(() => undefined);
    const period = new Date().toISOString().slice(0, 7);
    await env.DB.prepare("INSERT INTO usage_counter (org_id, period, x_api_posts) VALUES (?, ?, 15) ON CONFLICT(org_id, period) DO UPDATE SET x_api_posts = 15").bind(u.orgId, period).run(); // Starter: 15 used
    const id = await approvedPost(u.orgId, "x", "A post.");
    await env.DB.prepare("UPDATE draft SET auto_approved = 1, connection_id = ?, status = 'scheduled', scheduled_at = ? WHERE id = ?").bind(conn, Date.now() - 1000, id).run();
    await expect(publishDraft(await deps(), { orgId: u.orgId, draftId: id })).rejects.toThrow(/used up/);
    const row = await env.DB.prepare("SELECT status, last_error FROM draft WHERE id = ?").bind(id).first<{ status: string; last_error: string }>();
    expect(row).toMatchObject({ status: "approved", last_error: expect.stringContaining("Approve it yourself") });
    const used = await env.DB.prepare("SELECT x_api_posts FROM usage_counter WHERE org_id = ? AND period = ?").bind(u.orgId, period).first<{ x_api_posts: number }>();
    expect(used?.x_api_posts).toBe(15); // nothing charged
  });
});
