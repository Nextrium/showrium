import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb } from "@nextrium/db";
import {
  autoScheduleApproved,
  autoScheduledEmails,
  baseScore,
  createIdeas,
  effectiveScore,
  failedPostEmails,
  importTokenKey,
  moveAutoScheduled,
  parseDate,
  runDuePublishing,
  isApprovable,
  isStale,
  isWritable,
  listIdeas,
  parseFeed,
  publishDraft,
  publishingHealth,
  rescoreOldIdeas,
  goodUntil,
  inQuietHours,
  isUrgent,
  pickSlot,
  sendNeedsYouNotices,
  runAutopilotFor,
  sameStory,
  saveConnection,
  syncSource,
  type PublishDeps,
} from "@nextrium/core";
import { fakeProvider } from "@nextrium/llm";
import { errorReason } from "@nextrium/platforms";

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
  const secret = platform === "bluesky" ? { identifier: "ada", appPassword: "aaaa-bbbb-cccc-dddd" } : { tokens: { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + DAY } };
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

describe("scheduling clashes: the edges", () => {
  it("moving an automated post with no free time left puts it back in Approved (never posted unexpectedly)", async () => {
    const u = await user("is-nofree@example.com");
    const conn = await connect(u, "bluesky");
    await u.call("PUT", "/autopilot", settings({ windows: ["morning"], rules: { bluesky: { write: false, schedule: true, approve: false } } }));
    // Every morning of the next 15 days is already taken by your own posts.
    for (let d = 0; d < 15; d++) {
      const at = new Date(Date.now() + d * DAY);
      at.setUTCHours(8, 30, 0, 0);
      await env.DB.prepare("INSERT INTO draft (id, org_id, platform, text, status, issues, connection_id, scheduled_at) VALUES (?, ?, 'bluesky', 'Mine', 'scheduled', '[]', ?, ?)").bind(`drf_${crypto.randomUUID()}`, u.orgId, conn, at.getTime()).run();
    }
    const auto = await approvedPost(u.orgId, "bluesky");
    await env.DB.prepare("UPDATE draft SET status = 'scheduled', auto_scheduled = 1, connection_id = ?, scheduled_at = ? WHERE id = ?").bind(conn, Date.now() + 3 * DAY, auto).run();
    const moved = await moveAutoScheduled(createDb(env.DB), u.orgId, [auto]);
    expect(moved).toEqual([{ id: auto, at: null }]);
    expect(await env.DB.prepare("SELECT status, scheduled_at, auto_scheduled FROM draft WHERE id = ?").bind(auto).first()).toEqual({ status: "approved", scheduled_at: null, auto_scheduled: 0 });
  });

  it("never moves a post you scheduled yourself, and never another workspace's", async () => {
    const a = await user("is-mine-a@example.com");
    const b = await user("is-mine-b@example.com");
    const conn = await connect(a, "bluesky");
    const mine = await approvedPost(a.orgId, "bluesky");
    const at = Date.now() + 2 * DAY;
    await env.DB.prepare("UPDATE draft SET status = 'scheduled', auto_scheduled = 0, connection_id = ?, scheduled_at = ? WHERE id = ?").bind(conn, at, mine).run();
    expect(await moveAutoScheduled(createDb(env.DB), a.orgId, [mine])).toEqual([]);
    await env.DB.prepare("UPDATE draft SET auto_scheduled = 1 WHERE id = ?").bind(mine).run();
    expect(await moveAutoScheduled(createDb(env.DB), b.orgId, [mine])).toEqual([]); // not B's
    expect((await env.DB.prepare("SELECT scheduled_at FROM draft WHERE id = ?").bind(mine).first<{ scheduled_at: number }>())!.scheduled_at).toBe(at);
  });

  it("can't schedule on another workspace's account, and doesn't reveal its posts", async () => {
    const a = await user("is-cross-a@example.com");
    const b = await user("is-cross-b@example.com");
    const aConn = await connect(a, "bluesky");
    const aPost = await approvedPost(a.orgId, "bluesky", "A's secret plans");
    const at = new Date(Date.now() + 2 * DAY).toISOString();
    expect((await a.call("POST", `/drafts/${aPost}/schedule`, { connectionId: aConn, at })).status).toBe(200);
    const bPost = await approvedPost(b.orgId, "bluesky");
    const res = await b.call("POST", `/drafts/${bPost}/schedule`, { connectionId: aConn, at });
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(res.status).toBe(409);
    expect(body.error.code).toBe("no_connection"); // not a clash with A's post
    expect(body.error.message).not.toContain("scheduled near");
    // And B can't schedule A's post.
    expect((await b.call("POST", `/drafts/${aPost}/schedule`, { connectionId: aConn, at })).status).toBe(404);
  });
});

describe("before automated posts go out", () => {
  it("emails only owners and admins with a confirmed email; a failing email service doesn't stop the run", async () => {
    const u = await user("is-who@example.com");
    await env.DB.prepare("UPDATE user SET email_verified = 1 WHERE id = ?").bind(u.userId).run();
    const member = async (email: string, role: string, verified: number) => {
      const id = `u_${crypto.randomUUID()}`;
      await env.DB.prepare("INSERT INTO user (id, name, email, email_verified) VALUES (?, 'M', ?, ?)").bind(id, email, verified).run();
      await env.DB.prepare("INSERT INTO membership (id, org_id, user_id, role) VALUES (?, ?, ?, ?)").bind(`mem_${crypto.randomUUID()}`, u.orgId, id, role).run();
    };
    await member("is-who-admin@example.com", "admin", 1);
    await member("is-who-unconfirmed@example.com", "admin", 0);
    await member("is-who-editor@example.com", "editor", 1);
    await member("is-who-viewer@example.com", "viewer", 1);
    await connect(u, "bluesky");
    await u.call("PUT", "/autopilot", settings({ rules: { bluesky: { write: true, schedule: true, approve: true } } }));
    const id = await approvedPost(u.orgId, "bluesky");
    await autoScheduleApproved(createDb(env.DB), u.orgId, [id]);
    const to = (await autoScheduledEmails(createDb(env.DB), u.orgId, [id], BASE)).map((e) => e.to).sort();
    expect(to).toEqual(["is-who-admin@example.com", "is-who@example.com"]);
    // The notice hook throwing (e.g. the email service is down) doesn't fail the run.
    const ctx = `ctx_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO context_item (id, org_id, kind, title, body, published_at) VALUES (?, ?, 'manual', 'We shipped retries for every job', 'b', ?)").bind(ctx, u.orgId, Date.now()).run();
    await createIdeas(createDb(env.DB), u.orgId, "manual", [{ id: ctx, title: "We shipped retries for every job" }]);
    const out = await runAutopilotFor(createDb(env.DB), [fakeProvider((r) => reply(r.user))], u.orgId, new Date(), undefined, async () => {
      throw new Error("email service down");
    });
    expect(out).toMatchObject({ approved: 1, scheduled: 1 });
  });

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

describe("when a scheduled post fails", () => {
  it("keeps the platform's own reason, and tells the owners", async () => {
    const u = await user("is-fail@example.com");
    await env.DB.prepare("UPDATE user SET email_verified = 1 WHERE id = ?").bind(u.userId).run();
    const conn = await connect(u, "x");
    const id = await approvedPost(u.orgId, "x", "A short post.");
    await env.DB.prepare("UPDATE draft SET status = 'scheduled', connection_id = ?, scheduled_at = ? WHERE id = ?").bind(conn, Date.now() - 60_000, id).run();
    const xSays = async (url: string) =>
      url.includes("/2/tweets")
        ? new Response(JSON.stringify({ title: "Invalid Request", detail: "One or more parameters to your request was invalid.", type: "https://api.x.com/2/problems/invalid-request" }), { status: 400, headers: { "Content-Type": "application/problem+json" } })
        : new Response("{}", { status: 404 });
    const told: string[][] = [];
    const out = await runDuePublishing({ ...(await deps()), fetch: xSays as typeof fetch }, new Date(), 25, async (orgId, ids) => {
      if (orgId === u.orgId) told.push(ids);
    });
    expect(out.failed).toBeGreaterThanOrEqual(1);
    expect(told).toEqual([[id]]);
    const row = await env.DB.prepare("SELECT status, last_error FROM draft WHERE id = ?").bind(id).first<{ status: string; last_error: string }>();
    expect(row!.status).toBe("failed");
    expect(row!.last_error).toBe('X rejected the post (HTTP 400). X said: "One or more parameters to your request was invalid."');
    const emails = await failedPostEmails(createDb(env.DB), u.orgId, [id], BASE);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ to: "is-fail@example.com", subject: "A scheduled post didn't go out" });
    expect(emails[0]!.text).toContain("One or more parameters");
    expect(emails[0]!.text).toContain(`${BASE}/app/posts?status=failed`);
  });

  it("X out of paid API usage (HTTP 402 \"credits depleted\"): blamed on us, not the person; nothing charged; staff alerted", async () => {
    // The incident of 2026-10-19: our X developer account ran out of prepaid API credits.
    const u = await user("is-x402@example.com");
    const conn = await connect(u, "x");
    const id = await approvedPost(u.orgId, "x", "A short post.");
    await env.DB.prepare("UPDATE draft SET status = 'scheduled', connection_id = ?, scheduled_at = ? WHERE id = ?").bind(conn, Date.now() - 60_000, id).run();
    const depleted = async (url: string) =>
      url.includes("/2/tweets") ? Response.json({ title: "CreditsDepleted", detail: "Your enrolled account does not have any credits", type: "https://api.x.com/2/problems/credits" }, { status: 402 }) : new Response("{}", { status: 404 });
    await runDuePublishing({ ...(await deps()), fetch: depleted as typeof fetch }, new Date(), 25);
    const row = (await env.DB.prepare("SELECT status, last_error FROM draft WHERE id = ?").bind(id).first<{ status: string; last_error: string }>())!;
    expect(row.status).toBe("failed");
    expect(row.last_error).toContain("on our side, not your account or your credits");
    expect(row.last_error).toContain("Post it yourself");
    expect(row.last_error).not.toContain("credits depleted"); // X's wording would read as the person's Showrium credits
    // The account isn't marked to reconnect, and the plan's X post is given back.
    expect((await env.DB.prepare("SELECT status FROM connection WHERE id = ?").bind(conn).first<{ status: string }>())!.status).toBe("active");
    expect((await env.DB.prepare("SELECT x_api_posts AS n FROM usage_counter WHERE org_id = ?").bind(u.orgId).first<{ n: number }>())?.n ?? 0).toBe(0);
    // Staff see it at the top of Publishing health.
    expect((await publishingHealth(createDb(env.DB))).providerCredit).toEqual([expect.objectContaining({ platform: "x" })]);
  });

  it("a long X post after the sign-in expired: renews once, uploads the image and posts (X rotates renewal tokens)", async () => {
    // The incident of 2026-10-18: checking Premium renewed the sign-in, then posting tried to renew
    // again with the used token and X said "Value passed for the token was invalid."
    const u = await user("is-xlong@example.com");
    const d = await deps();
    const secret = { tokens: { accessToken: "a1", refreshToken: "r1", expiresAt: Date.now() - 60_000 } };
    await saveConnection(d, { orgId: u.orgId, platform: "x", account: { accountId: "x-long", handle: "@long" }, secret, meta: { subscription: "Premium" }, userId: u.userId });
    const conn = (await env.DB.prepare("SELECT id FROM connection WHERE org_id = ? AND platform = 'x'").bind(u.orgId).first<{ id: string }>())!.id;
    const text = `${"Trust that already exists should count. ".repeat(40)}`.trim(); // ~1,600 characters
    const id = await approvedPost(u.orgId, "x", text);
    await env.DB.prepare("UPDATE draft SET connection_id = ?, own_images = 1 WHERE id = ?").bind(conn, id).run();
    const original = JSON.stringify({ key: `orgs/${u.orgId}/images/${id}.png`, mime: "image/png", bytes: 10243, width: 512, height: 512 });
    await env.DB.prepare("INSERT INTO post_image (id, org_id, draft_id, position, source, alt, original, variants) VALUES (?, ?, ?, 0, 'link', 'Logo', ?, '{}')").bind(`img_${crypto.randomUUID()}`, u.orgId, id, original).run();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 2, 0, 0, 0, 2, 0]);
    const media = { put: async () => undefined, delete: async () => undefined, get: async () => ({ arrayBuffer: async () => png.buffer.slice(0) }) };
    // A fake X that enforces rotation: each renewal token works once.
    const used = new Set<string>();
    let renewals = 0;
    let posted: { text: string; media?: { media_ids: string[] } } | null = null;
    const fakeX = async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      if (url.endsWith("/2/oauth2/token")) {
        const token = new URLSearchParams(String(init?.body)).get("refresh_token")!;
        if (used.has(token)) return Response.json({ error: "invalid_request", error_description: "Value passed for the token was invalid." }, { status: 400 });
        used.add(token);
        renewals++;
        return Response.json({ access_token: `a${renewals + 1}`, refresh_token: `r${renewals + 1}`, expires_in: 7200 });
      }
      if (auth === "Bearer a1") return Response.json({ title: "Unauthorized" }, { status: 401 }); // the expired one
      if (url.includes("/2/users/me")) return Response.json({ data: { id: "x-long", username: "long", subscription_type: "Premium" } });
      if (url.endsWith("/2/media/upload")) return Response.json({ data: { id: "m1" } });
      if (url.endsWith("/2/media/metadata")) return Response.json({});
      if (url.endsWith("/2/tweets")) {
        posted = JSON.parse(String(init?.body));
        return Response.json({ data: { id: "t1" } });
      }
      return new Response("{}", { status: 404 });
    };
    const out = await publishDraft({ ...d, fetch: fakeX as typeof fetch, media, configs: { ...d.configs, x: { clientId: "c", clientSecret: "s", redirectUri: `${BASE}/cb` } } }, { orgId: u.orgId, draftId: id });
    expect(out).toMatchObject({ status: "published", url: "https://x.com/long/status/t1" });
    expect(renewals).toBe(1);
    expect(posted!.media).toEqual({ media_ids: ["m1"] }); // the image went with it
    expect(posted!.text.length).toBeGreaterThan(280);
    const row = await env.DB.prepare("SELECT status, last_error FROM draft WHERE id = ?").bind(id).first();
    expect(row).toEqual({ status: "published", last_error: null });
  });

  it("a renewal refused because another request renewed first uses the stored tokens; a dead sign-in asks to reconnect", async () => {
    const u = await user("is-xrace@example.com");
    const d = await deps();
    const cfg = { ...d.configs, x: { clientId: "c", clientSecret: "s", redirectUri: `${BASE}/cb` } };
    await saveConnection(d, { orgId: u.orgId, platform: "x", account: { accountId: "x-race", handle: "@race" }, secret: { tokens: { accessToken: "old", refreshToken: "r-old", expiresAt: Date.now() - 60_000 } }, meta: { subscription: "None" }, userId: u.userId });
    const conn = (await env.DB.prepare("SELECT id FROM connection WHERE org_id = ? AND platform = 'x'").bind(u.orgId).first<{ id: string }>())!.id;
    const id = await approvedPost(u.orgId, "x", "Short post.");
    await env.DB.prepare("UPDATE draft SET connection_id = ? WHERE id = ?").bind(conn, id).run();
    let tweetedWith = "";
    const refused = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/2/oauth2/token")) {
        // Meanwhile another request renewed and stored fresh tokens.
        await saveConnection(d, { orgId: u.orgId, platform: "x", account: { accountId: "x-race", handle: "@race" }, secret: { tokens: { accessToken: "fresh", refreshToken: "r-new", expiresAt: Date.now() + 7_000_000 } }, meta: { subscription: "None" }, userId: u.userId });
        return Response.json({ error_description: "Value passed for the token was invalid." }, { status: 400 });
      }
      if (url.endsWith("/2/tweets")) {
        tweetedWith = new Headers(init?.headers).get("Authorization") ?? "";
        return Response.json({ data: { id: "t2" } });
      }
      return new Response("{}", { status: 404 });
    };
    expect(await publishDraft({ ...d, fetch: refused as typeof fetch, configs: cfg }, { orgId: u.orgId, draftId: id })).toMatchObject({ status: "published" });
    expect(tweetedWith).toBe("Bearer fresh");

    // No fresher tokens anywhere: the sign-in is dead. Say so, and mark the account to reconnect.
    const id2 = await approvedPost(u.orgId, "x", "Another short post.");
    await env.DB.prepare("UPDATE draft SET connection_id = ? WHERE id = ?").bind(conn, id2).run();
    await saveConnection(d, { orgId: u.orgId, platform: "x", account: { accountId: "x-race", handle: "@race" }, secret: { tokens: { accessToken: "x", refreshToken: "r-dead", expiresAt: Date.now() - 60_000 } }, meta: { subscription: "None" }, userId: u.userId });
    const dead = async (url: string) => (url.endsWith("/2/oauth2/token") ? Response.json({ error_description: "Value passed for the token was invalid." }, { status: 400 }) : new Response("{}", { status: 404 }));
    await expect(publishDraft({ ...d, fetch: dead as typeof fetch, configs: cfg }, { orgId: u.orgId, draftId: id2 })).rejects.toThrow(/sign in again/);
    expect(await env.DB.prepare("SELECT status FROM connection WHERE id = ?").bind(conn).first()).toEqual({ status: "needs_reconnect" });
  });

  it("reads reasons safely from any kind of error response", async () => {
    const r = (body: string, type = "application/json") => new Response(body, { status: 400, headers: { "Content-Type": type } });
    expect(await errorReason(r(JSON.stringify({ errors: [{ message: "Status is a duplicate." }] })))).toBe("Status is a duplicate.");
    expect(await errorReason(r(JSON.stringify({ message: "Unable to create post", status: 422 })))).toBe("Unable to create post");
    expect(await errorReason(r("<html><body>Bad gateway</body></html>", "text/html"))).toBe(""); // HTML pages say nothing useful
    expect(await errorReason(r(JSON.stringify({ detail: "line one\n\u0007line two" })))).toBe("line one line two"); // control characters stripped
    expect((await errorReason(r(JSON.stringify({ detail: "word ".repeat(100) })))).length).toBe(200); // capped
    expect(await errorReason(r("not json at all"))).toBe(""); // raw text is never echoed
    expect(await errorReason(r(JSON.stringify({ detail: "Bad token abcdefghijklmnopqrstuvwxyz0123456789 given" })))).toBe("Bad token … given");
    expect(await errorReason(r(""))).toBe("");
  });

  it("ignores future or garbage dates in feeds", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    expect(parseDate("Sun, 18 Oct 2026 08:00:00 GMT", now)?.toISOString()).toBe("2026-10-18T08:00:00.000Z");
    expect(parseDate("2027-01-01T00:00:00Z", now)).toBeNull(); // the future
    expect(parseDate("yesterday-ish", now)).toBeNull();
    expect(parseDate("", now)).toBeNull();
    expect(parseDate("1970-01-01T00:00:00Z", now)).toBeNull();
  });
});

describe("time-sensitive posts and 'needs you' (owner decision 2026-10-19)", () => {
  const H = 3_600_000;
  /** An approved post written from material published `hoursAgo` (from a passion the person follows, unless `own`). */
  async function postFrom(u: Awaited<ReturnType<typeof user>>, platform: string, hoursAgo: number, own = false) {
    let sourceId: string | null = null;
    if (!own) {
      const p = (await (await u.call("POST", "/passions", { name: `News ${crypto.randomUUID().slice(0, 6)}` })).json()) as { id: string };
      sourceId = `src_${crypto.randomUUID()}`;
      await env.DB.prepare("INSERT INTO source (id, org_id, kind, key, passion_id) VALUES (?, ?, 'rss', ?, ?)").bind(sourceId, u.orgId, `https://news.example/${sourceId}`, p.id).run();
    }
    const ctx = `ctx_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO context_item (id, org_id, source_id, kind, title, body, published_at) VALUES (?, ?, ?, 'rss_item', 'News', 'b', ?)").bind(ctx, u.orgId, sourceId, Date.now() - hoursAgo * H).run();
    const brief = `brf_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO brief (id, org_id, context_item_id, mode, angle, key_points, model) VALUES (?, ?, ?, 'teach', 'a', '[]', 'test')").bind(brief, u.orgId, ctx).run();
    const id = await approvedPost(u.orgId, platform);
    await env.DB.prepare("UPDATE draft SET brief_id = ? WHERE id = ?").bind(brief, id).run();
    return id;
  }

  it("knows how long a post stays worth posting, what's urgent, and the quiet hours", () => {
    const at = new Date("2026-10-19T08:00:00Z");
    expect(goodUntil("rss_item", "outside", at, at).toISOString()).toBe("2026-10-21T08:00:00.000Z"); // news: 48 hours
    expect(goodUntil("github_release", "own", at, at).toISOString()).toBe("2026-10-26T08:00:00.000Z"); // your release: 7 days
    expect(goodUntil("manual", "own", at, at).toISOString()).toBe("2026-11-18T08:00:00.000Z"); // a note: 30 days
    expect(isUrgent({ score: 80, age: 2 * H, origin: "outside", kind: "rss_item", title: "Anything" })).toBe(true);
    expect(isUrgent({ score: 80, age: 2 * H, origin: "own", kind: "manual", title: "Voting closes today" })).toBe(true);
    expect(isUrgent({ score: 80, age: 2 * H, origin: "own", kind: "manual", title: "Thoughts on naming" })).toBe(false);
    expect(isUrgent({ score: 90, age: 2 * H, origin: "own", kind: "github_release", title: "acme/app v2.0.0" })).toBe(false); // your own release keeps for a week
    expect(isUrgent({ score: 70, age: 2 * H, origin: "outside", kind: "rss_item", title: "Launched" })).toBe(false); // not strong enough
    expect(isUrgent({ score: 90, age: 30 * H, origin: "outside", kind: "rss_item", title: "Launched" })).toBe(false); // not fresh
    expect([22, 23, 0, 6].every(inQuietHours)).toBe(true);
    expect([7, 12, 21].some(inQuietHours)).toBe(false);
    // The slot picker never goes past a post's deadline.
    const now = new Date("2026-10-19T20:30:00Z");
    const base = { now, tz: "UTC", days: [0, 1, 2, 3, 4, 5, 6], windows: ["morning" as const], perDay: 1, taken: [], stats: {} };
    expect(pickSlot({ ...base, notAfter: new Date("2026-10-20T06:00:00Z") })).toBeNull(); // the next morning slot is after it
    expect(pickSlot({ ...base, notAfter: new Date("2026-10-20T12:00:00Z") })!.getTime()).toBeLessThanOrEqual(Date.parse("2026-10-20T12:00:00Z"));
  });

  it("never schedules news after it goes stale: it's handed to you instead", async () => {
    const u = await user("is-stale@example.com");
    await connect(u, "bluesky");
    // Only evening slots, one a day; this evening is already taken by your own post.
    await u.call("PUT", "/autopilot", settings({ windows: ["evening"], rules: { bluesky: { write: false, schedule: true, approve: false } } }));
    const conn = (await env.DB.prepare("SELECT id FROM connection WHERE org_id = ?").bind(u.orgId).first<{ id: string }>())!.id;
    const evening = new Date();
    evening.setUTCHours(20, 30, 0, 0);
    if (evening.getTime() < Date.now() + 3 * H) evening.setUTCDate(evening.getUTCDate() + 1);
    await env.DB.prepare("INSERT INTO draft (id, org_id, platform, text, status, issues, connection_id, scheduled_at) VALUES (?, ?, 'bluesky', 'Mine', 'scheduled', '[]', ?, ?)").bind(`drf_${crypto.randomUUID()}`, u.orgId, conn, evening.getTime()).run();
    // News published 46 hours ago: good for 2 more hours, and there's no free slot before then.
    const id = await postFrom(u, "bluesky", 46);
    expect(await autoScheduleApproved(createDb(env.DB), u.orgId, [id])).toBe(0);
    const row = (await env.DB.prepare("SELECT status, urgent_until FROM draft WHERE id = ?").bind(id).first<{ status: string; urgent_until: number }>())!;
    expect(row.status).toBe("approved");
    expect(Math.abs(row.urgent_until - (Date.now() + 2 * H))).toBeLessThan(5 * 60_000);
    // It shows as "needs you", and Skip clears it (the post stays).
    expect(((await (await u.call("GET", "/summary")).json()) as { needsYou: number }).needsYou).toBe(1);
    const list = (await (await u.call("GET", "/drafts?needsYou=true")).json()) as { data: { id: string; urgentUntil: string | null }[] };
    expect(list.data.map((d) => d.id)).toEqual([id]);
    expect(list.data[0]!.urgentUntil).not.toBeNull();
    const skipped = (await (await u.call("PATCH", `/drafts/${id}`, { needsYou: false })).json()) as { draft: { status: string; urgentUntil: string | null } };
    expect(skipped.draft).toMatchObject({ status: "approved", urgentUntil: null });
    // Your own old note isn't urgent: no deadline within the week, it simply stays approved.
    const note = await postFrom(u, "bluesky", 46, true);
    await autoScheduleApproved(createDb(env.DB), u.orgId, [note]);
    expect((await env.DB.prepare("SELECT urgent_until FROM draft WHERE id = ?").bind(note).first<{ urgent_until: number | null }>())!.urgent_until).toBeNull();
  });

  it("when the day's automated posts are used, urgent news is still written (2 a day at most) and marked 'needs you'", async () => {
    const u = await user("is-urgentrun@example.com");
    await u.call("PUT", "/autopilot", settings({ rules: { linkedin: { write: true, schedule: false, approve: false } }, perDay: { linkedin: 1 } }));
    // Today's automated LinkedIn post is already written.
    await env.DB.prepare("UPDATE autopilot SET week_log = ? WHERE org_id = ?").bind(JSON.stringify([{ at: Date.now() - 60_000, mode: "teach", platforms: ["linkedin"] }]), u.orgId).run();
    const p = (await (await u.call("POST", "/passions", { name: "Cardano" })).json()) as { id: string };
    const fresh = async (title: string) => {
      const src = `src_${crypto.randomUUID()}`;
      await env.DB.prepare("INSERT INTO source (id, org_id, kind, key, passion_id) VALUES (?, ?, 'rss', ?, ?)").bind(src, u.orgId, `https://n.example/${src}`, p.id).run();
      const ctx = `ctx_${crypto.randomUUID()}`;
      await env.DB.prepare("INSERT INTO context_item (id, org_id, source_id, kind, title, body, published_at) VALUES (?, ?, ?, 'rss_item', ?, 'b', ?)").bind(ctx, u.orgId, src, title, Date.now() - H).run();
      await createIdeas(createDb(env.DB), u.orgId, "rss_item", [{ id: ctx, title }], "Cardano", { passionName: "Cardano" });
    };
    await fresh("Cardano node 10.5 released with faster sync");
    await fresh("Cardano governance vote opens for treasury withdrawals");
    await fresh("Cardano wallet 3.1 released with hardware support");
    const run = () => runAutopilotFor(createDb(env.DB), [fakeProvider((r) => reply(r.user))], u.orgId);
    expect(await run()).toMatchObject({ urgent: true, drafts: 1, approved: 0 });
    const marked = await env.DB.prepare("SELECT urgent_until FROM draft WHERE org_id = ? AND status = 'draft'").bind(u.orgId).all<{ urgent_until: number | null }>();
    expect(marked.results.every((r) => r.urgent_until && r.urgent_until > Date.now())).toBe(true);
    expect(await run()).toMatchObject({ urgent: true });
    expect(await run()).toEqual({ skipped: "daily_limit" }); // at most 2 extra a day
  });

  it("emails at most 3 a day, never in the quiet hours, each post once", async () => {
    const u = await user("is-alerts@example.com");
    await env.DB.prepare("UPDATE user SET email_verified = 1 WHERE id = ?").bind(u.userId).run();
    await u.call("PUT", "/autopilot", settings({ timezone: "UTC" }));
    // Fixed times (UTC workspace): a night check, then the next day's.
    const night = new Date("2030-03-04T23:30:00Z");
    const morning = new Date("2030-03-05T08:00:00Z");
    for (let i = 0; i < 5; i++) {
      const id = await approvedPost(u.orgId, "linkedin", `Urgent ${i}`);
      await env.DB.prepare("UPDATE draft SET urgent_until = ? WHERE id = ?").bind(Date.parse("2030-03-05T18:00:00Z") + i * H, id).run();
    }
    const sent: string[] = [];
    const send = async (emails: { to: string; text: string }[]) => sent.push(...emails.filter((e) => e.to === "is-alerts@example.com").map((e) => e.text));
    await sendNeedsYouNotices(createDb(env.DB), BASE, send, night);
    expect(sent).toEqual([]); // quiet hours: nothing
    await sendNeedsYouNotices(createDb(env.DB), BASE, send, morning);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.match(/• LinkedIn/g)).toHaveLength(3); // the 3 most pressing, in one email
    expect(sent[0]).toContain("Urgent 0");
    expect(sent[0]).not.toContain("Urgent 4");
    expect(sent[0]).toContain(`${BASE}/app/posts?needs=1`);
    await sendNeedsYouNotices(createDb(env.DB), BASE, send, new Date("2030-03-05T10:00:00Z"));
    expect(sent).toHaveLength(1); // the day's 3 are used; the same posts are never emailed twice
    const notified = await env.DB.prepare("SELECT count(*) AS n FROM draft WHERE org_id = ? AND urgent_notified_at IS NOT NULL").bind(u.orgId).first<{ n: number }>();
    expect(notified!.n).toBe(3);
  });
});

describe("API keys (for developers and agents)", () => {
  it("can use passions and scheduling, within the same checks", async () => {
    const u = await user("is-key@example.com");
    const { key } = (await (await u.call("POST", "/api-keys", { name: "agent" })).json()) as { key: string };
    const call = (method: string, path: string, body?: unknown) => SELF.fetch(`${BASE}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const made = await call("POST", "/passions", { name: "Open source" });
    expect(made.status).toBe(201);
    expect((await call("POST", "/passions", { name: "x".repeat(61) })).status).toBe(400);
    const conn = await connect(u, "bluesky");
    const one = await approvedPost(u.orgId, "bluesky");
    const two = await approvedPost(u.orgId, "bluesky");
    const at = new Date(Date.now() + 2 * DAY).toISOString();
    expect((await call("POST", `/drafts/${one}/schedule`, { connectionId: conn, at })).status).toBe(200);
    expect((await call("POST", `/drafts/${two}/schedule`, { connectionId: conn, at })).status).toBe(409); // clash rules apply to keys too
    const audit = await env.DB.prepare("SELECT actor_api_key_id FROM audit_event WHERE org_id = ? AND action = 'passion.created'").bind(u.orgId).first<{ actor_api_key_id: string | null }>();
    expect(audit?.actor_api_key_id).toBeTruthy();
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

  it("an X post with a link never goes through the API: not published, not scheduled, not auto-approved (owner decision 2026-10-19)", async () => {
    const u = await user("is-xlink@example.com");
    const conn = await connect(u, "x");
    const id = await approvedPost(u.orgId, "x", "GovTool makes governance usable. Link in the reply 👇\n\nhttps://github.com/intersectmbo/govtool");
    await env.DB.prepare("UPDATE draft SET connection_id = ?, parts = ? WHERE id = ?").bind(conn, JSON.stringify(["GovTool makes governance usable. Link in the reply 👇", "https://github.com/intersectmbo/govtool"]), id).run();
    let calledX = false;
    const spy = async () => ((calledX = true), new Response("{}"));
    await expect(publishDraft({ ...(await deps()), fetch: spy as typeof fetch }, { orgId: u.orgId, draftId: id })).rejects.toThrow(/Post it myself/);
    expect(calledX).toBe(false); // X was never contacted
    expect((await env.DB.prepare("SELECT status FROM draft WHERE id = ?").bind(id).first<{ status: string }>())!.status).toBe("approved"); // untouched, ready to post yourself
    const sched = await u.call("POST", `/drafts/${id}/schedule`, { connectionId: conn, at: new Date(Date.now() + 2 * DAY).toISOString() });
    expect(sched.status).toBe(409);
    expect(((await sched.json()) as { error: { code: string } }).error.code).toBe("needs_tap_to_post");
    const now = await u.call("POST", `/drafts/${id}/publish`, { connectionId: conn });
    expect(((await now.json()) as { error: { code: string } }).error.code).toBe("needs_tap_to_post");
    // Without a link, the same account still posts through the app.
    const plain = await approvedPost(u.orgId, "x", "No link here.");
    await env.DB.prepare("UPDATE draft SET connection_id = ? WHERE id = ?").bind(conn, plain).run();
    const ok = async (url: string) => (url.endsWith("/2/tweets") ? Response.json({ data: { id: "t9" } }) : new Response("{}", { status: 404 }));
    expect(await publishDraft({ ...(await deps()), fetch: ok as typeof fetch }, { orgId: u.orgId, draftId: plain })).toMatchObject({ status: "published" });
  });

  it("automation doesn't approve an X post that carries a link (it's left for you to post yourself)", async () => {
    const u = await user("is-xlinkauto@example.com");
    await connect(u, "x");
    expect((await u.call("PUT", "/autopilot", { ...settings({ rules: { x: { write: true, schedule: true, approve: true } } }), xConsent: true })).status).toBe(200);
    const ctx = `ctx_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO context_item (id, org_id, kind, title, body, url, published_at) VALUES (?, ?, 'rss_item', 'We released queue retries v2.0', 'b', 'https://blog.example/retries', ?)").bind(ctx, u.orgId, Date.now()).run();
    await createIdeas(createDb(env.DB), u.orgId, "rss_item", [{ id: ctx, title: "We released queue retries v2.0" }]);
    const out = await runAutopilotFor(createDb(env.DB), [fakeProvider((r) => reply(r.user))], u.orgId);
    expect(out).toMatchObject({ drafts: 1, approved: 0, scheduled: 0 });
    const row = await env.DB.prepare("SELECT status, parts FROM draft WHERE org_id = ? AND platform = 'x'").bind(u.orgId).first<{ status: string; parts: string }>();
    expect(row!.status).toBe("draft");
    expect(JSON.parse(row!.parts)[1]).toBe("https://blog.example/retries"); // the link waits in the reply, for "Post it myself"
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
