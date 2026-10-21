import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb } from "@nextrium/db";
import { aiCostReport, estimateNarration, estimateTranscription, getBalance, importTokenKey, pauseWorkspace, postCreditTxn, publishDraft, resumeWorkspace, runAutopilotFor, runDuePublishing, saveConnection, workspaceCosts, type PublishDeps } from "@nextrium/core";
import { fakeProvider } from "@nextrium/llm";

// Admin phase 2 (owner decisions 2026-10-19): every AI call's cost is recorded, and a paused workspace
// stops automation and publishing (nothing deleted, scheduled posts wait) until it's resumed.
const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.52.${Math.floor(++n / 250)}.${n % 250}`;

async function user(email: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() }, body: JSON.stringify({ email, name: "P2", password: "correct-horse-battery" }) });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = (method: string, path: string, body?: unknown) =>
    SELF.fetch(`${BASE}/api/v1${path}`, { method, headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  await call("PUT", "/persona", { displayName: "P2", platforms: ["bluesky", "linkedin"] });
  const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string } };
  await env.DB.prepare("UPDATE org SET plan = 'creator' WHERE id = ?").bind(me.workspace.id).run();
  const row = await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>();
  return { call, orgId: me.workspace.id, userId: row!.id };
}

describe("AI cost ledger", () => {
  it("records what writing posts costs (and estimates for Workers AI)", async () => {
    const u = await user("p2-ledger@example.com");
    const ctx = (await (await u.call("POST", "/contexts", { kind: "manual", body: "We shipped retries with backoff today." })).json()) as { id: string };
    const out = (await (await u.call("POST", "/compose", { contextItemId: ctx.id, mode: "teach", platforms: ["linkedin"] })).json()) as { briefId: string };
    const row = await env.DB.prepare("SELECT feature, model, estimated FROM ai_usage WHERE org_id = ? AND ref_id = ?").bind(u.orgId, out.briefId).first<{ feature: string; model: string; estimated: number }>();
    expect(row).toMatchObject({ feature: "write", estimated: 0 });
    // Estimates scale with length and are never zero.
    expect(estimateTranscription("one two three")).toBeGreaterThanOrEqual(1);
    expect(estimateTranscription("word ".repeat(300))).toBe(1000); // 2 minutes at $0.0005
    expect(estimateNarration("x".repeat(1800))).toBe(400); // 2 minutes at $0.0002
  });
});

describe("X costs (measured against X's console 2026-10-20)", () => {
  it("charges 1 credit per image after the first, records what X charged, and shows it to the workspace (only its own)", async () => {
    const u = await user("p2-xcost@example.com");
    await env.DB.prepare("UPDATE org SET plan = 'free' WHERE id = ?").bind(u.orgId).run(); // no X allowance: credits
    const deps: PublishDeps = { db: createDb(env.DB), key: await importTokenKey(env.TOKEN_ENCRYPTION_KEY), configs: { mastodonRedirectUri: `${BASE}/cb` } };
    await saveConnection(deps, { orgId: u.orgId, platform: "x", account: { accountId: "x-cost", handle: "@cost" }, secret: { tokens: { accessToken: "a1", refreshToken: "r1", expiresAt: Date.now() + 3600_000 } }, meta: {}, userId: u.userId });
    const conn = (await env.DB.prepare("SELECT id FROM connection WHERE org_id = ? AND platform = 'x'").bind(u.orgId).first<{ id: string }>())!.id;
    const id = `drf_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO draft (id, org_id, platform, text, status, issues, connection_id, own_images) VALUES (?, ?, 'x', 'Three pictures from the launch.', 'approved', '[]', ?, 1)").bind(id, u.orgId, conn).run();
    const original = (n: number) => JSON.stringify({ key: `orgs/${u.orgId}/images/${id}-${n}.png`, mime: "image/png", bytes: 10243, width: 512, height: 512 });
    for (let n = 0; n < 3; n++) await env.DB.prepare("INSERT INTO post_image (id, org_id, draft_id, position, source, alt, original, variants) VALUES (?, ?, ?, ?, 'upload', ?, ?, '{}')").bind(`img_${crypto.randomUUID()}`, u.orgId, id, n, `Photo ${n + 1}`, original(n)).run();
    await postCreditTxn(deps.db, { orgId: u.orgId, kind: "purchase", amount: 100, idempotencyKey: `topup:${u.orgId}`, description: "Pack" });
    const before = await getBalance(deps.db, u.orgId);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 2, 0, 0, 0, 2, 0]);
    const media = { put: async () => undefined, delete: async () => undefined, get: async () => ({ arrayBuffer: async () => png.buffer.slice(0) }) };
    let uploads = 0;
    const fakeX = async (url: string) =>
      url.endsWith("/2/media/upload") ? Response.json({ data: { id: `m${++uploads}` } }) : url.endsWith("/2/media/metadata") ? Response.json({}) : url.endsWith("/2/tweets") ? Response.json({ data: { id: "t1" } }) : new Response("{}", { status: 404 });
    expect(await publishDraft({ ...deps, fetch: fakeX as typeof fetch, media }, { orgId: u.orgId, draftId: id })).toMatchObject({ status: "published" });
    expect(uploads).toBe(3);
    // 2 for the post, plus 1 each for images 2 and 3.
    expect(before - (await getBalance(deps.db, u.orgId))).toBe(4);
    // What X charged: one post ($0.015) and three image descriptions ($0.005 each).
    const rows = await env.DB.prepare("SELECT kind, cost_micro_usd AS c FROM platform_usage WHERE org_id = ? ORDER BY kind").bind(u.orgId).all<{ kind: string; c: number }>();
    expect(rows.results).toEqual([{ kind: "image_description", c: 5000 }, { kind: "image_description", c: 5000 }, { kind: "image_description", c: 5000 }, { kind: "post", c: 15000 }]);
    expect((await workspaceCosts(deps.db, u.orgId)).x).toEqual({ usd: 0.03, posts: 1, images: 3, reads: 0 });
    // The workspace sees its own costs (AI and X); another workspace sees none of them.
    const mine = (await (await u.call("GET", "/costs")).json()) as { totalUsd: number; x: { usd: number } };
    expect(mine.x.usd).toBe(0.03);
    expect(mine.totalUsd).toBeGreaterThanOrEqual(0.03);
    const other = await user("p2-xcost-other@example.com");
    expect(((await (await other.call("GET", "/costs")).json()) as { x: { usd: number; posts: number } }).x).toMatchObject({ usd: 0, posts: 0 });
    // Staff see it in the admin cost report, against the workspace.
    const report = await aiCostReport(deps.db);
    expect(report.xApi.images).toBeGreaterThanOrEqual(3);
    expect(report.workspaces.find((w) => w.orgId === u.orgId)).toMatchObject({ xUsd: 0.03 });
  });

  it("a failed X post records no cost; the costs endpoint needs a signed-in workspace", async () => {
    const u = await user("p2-xcost-fail@example.com");
    const deps: PublishDeps = { db: createDb(env.DB), key: await importTokenKey(env.TOKEN_ENCRYPTION_KEY), configs: { mastodonRedirectUri: `${BASE}/cb` } };
    await saveConnection(deps, { orgId: u.orgId, platform: "x", account: { accountId: "x-fail", handle: "@fail" }, secret: { tokens: { accessToken: "a1", refreshToken: "r1", expiresAt: Date.now() + 3600_000 } }, meta: {}, userId: u.userId });
    const conn = (await env.DB.prepare("SELECT id FROM connection WHERE org_id = ? AND platform = 'x'").bind(u.orgId).first<{ id: string }>())!.id;
    const id = `drf_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO draft (id, org_id, platform, text, status, issues, connection_id) VALUES (?, ?, 'x', 'Hello.', 'approved', '[]', ?)").bind(id, u.orgId, conn).run();
    const refuse = async (url: string) => (url.endsWith("/2/tweets") ? Response.json({ detail: "nope" }, { status: 400 }) : new Response("{}", { status: 404 }));
    await expect(publishDraft({ ...deps, fetch: refuse as typeof fetch }, { orgId: u.orgId, draftId: id })).rejects.toThrow();
    expect((await env.DB.prepare("SELECT count(*) AS n FROM platform_usage WHERE org_id = ?").bind(u.orgId).first<{ n: number }>())!.n).toBe(0);
    expect((await SELF.fetch(`${BASE}/api/v1/costs`)).status).toBe(401);
  });
});

describe("posts waiting on an account that was removed (incident 2026-10-19)", () => {
  it("move to the account when it's connected again, and post from it", async () => {
    const u = await user("p2-relink@example.com");
    const deps: PublishDeps = { db: createDb(env.DB), key: await importTokenKey(env.TOKEN_ENCRYPTION_KEY), configs: { mastodonRedirectUri: `${BASE}/cb` } };
    // Posts scheduled on an X account that was then removed (the owner disconnected and connected again).
    const gone = "cn_removed_x";
    const ids = [`drf_${crypto.randomUUID()}`, `drf_${crypto.randomUUID()}`];
    for (const id of ids) await env.DB.prepare("INSERT INTO draft (id, org_id, platform, text, status, issues, connection_id, scheduled_at) VALUES (?, ?, 'bluesky', 'Waiting', 'scheduled', '[]', ?, ?)").bind(id, u.orgId, gone, Date.now() + 3600_000).run();
    const other = `drf_${crypto.randomUUID()}`; // a LinkedIn post isn't touched
    await env.DB.prepare("INSERT INTO draft (id, org_id, platform, text, status, issues, connection_id, scheduled_at) VALUES (?, ?, 'linkedin', 'Other', 'scheduled', '[]', ?, ?)").bind(other, u.orgId, "cn_removed_li", Date.now() + 3600_000).run();
    const fresh = await saveConnection(deps, { orgId: u.orgId, platform: "bluesky", account: { accountId: "did:plc:new", handle: "@new" }, secret: { identifier: "n", appPassword: "aaaa-bbbb-cccc-dddd" }, meta: {}, userId: u.userId });
    const rows = await env.DB.prepare("SELECT id, connection_id FROM draft WHERE org_id = ?").bind(u.orgId).all<{ id: string; connection_id: string }>();
    for (const id of ids) expect(rows.results.find((r) => r.id === id)!.connection_id).toBe(fresh);
    expect(rows.results.find((r) => r.id === other)!.connection_id).toBe("cn_removed_li");
    const audit = await env.DB.prepare("SELECT meta FROM audit_event WHERE org_id = ? AND action = 'connection.saved'").bind(u.orgId).first<{ meta: string }>();
    expect(JSON.parse(audit!.meta)).toMatchObject({ postsMoved: 2 });
  });

  it("when publishing, a post whose account was removed uses the one account left on that platform (never guesses between two)", async () => {
    const u = await user("p2-fallback@example.com");
    const deps: PublishDeps = { db: createDb(env.DB), key: await importTokenKey(env.TOKEN_ENCRYPTION_KEY), configs: { mastodonRedirectUri: `${BASE}/cb` } };
    await saveConnection(deps, { orgId: u.orgId, platform: "bluesky", account: { accountId: "did:plc:one", handle: "@one" }, secret: { identifier: "o", appPassword: "aaaa-bbbb-cccc-dddd" }, meta: {}, userId: u.userId });
    const id = `drf_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO draft (id, org_id, platform, text, status, issues, connection_id, scheduled_at) VALUES (?, ?, 'bluesky', 'Hello', 'scheduled', '[]', 'cn_gone', ?)").bind(id, u.orgId, Date.now() - 60_000).run();
    const ok = async (url: string) => (url.includes("createSession") ? Response.json({ accessJwt: "j", did: "did:plc:one", handle: "one" }) : url.includes("createRecord") ? Response.json({ uri: "at://did:plc:one/app.bsky.feed.post/1", cid: "c" }) : new Response("{}", { status: 404 }));
    expect(await publishDraft({ ...deps, fetch: ok as typeof fetch }, { orgId: u.orgId, draftId: id })).toMatchObject({ status: "published" });
    // Two Bluesky accounts: it won't guess.
    await saveConnection(deps, { orgId: u.orgId, platform: "bluesky", account: { accountId: "did:plc:two", handle: "@two" }, secret: { identifier: "t", appPassword: "aaaa-bbbb-cccc-dddd" }, meta: {}, userId: u.userId });
    const id2 = `drf_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO draft (id, org_id, platform, text, status, issues, connection_id, scheduled_at) VALUES (?, ?, 'bluesky', 'Hello again', 'scheduled', '[]', 'cn_gone_2', ?)").bind(id2, u.orgId, Date.now() - 60_000).run();
    await expect(publishDraft({ ...deps, fetch: ok as typeof fetch }, { orgId: u.orgId, draftId: id2 })).rejects.toThrow(/isn't connected any more/);
  });
});

describe("a paused workspace", () => {
  it("doesn't post or automate; its scheduled posts wait; it sees that it's paused, not why; resume brings it back", async () => {
    const u = await user("p2-paused@example.com");
    const deps: PublishDeps = { db: createDb(env.DB), key: await importTokenKey(env.TOKEN_ENCRYPTION_KEY), configs: { mastodonRedirectUri: `${BASE}/cb` } };
    await saveConnection(deps, { orgId: u.orgId, platform: "bluesky", account: { accountId: "did:plc:p2", handle: "@p2" }, secret: { identifier: "p2", appPassword: "aaaa-bbbb-cccc-dddd" }, meta: {}, userId: u.userId });
    const conn = (await env.DB.prepare("SELECT id FROM connection WHERE org_id = ?").bind(u.orgId).first<{ id: string }>())!.id;
    const due = `drf_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO draft (id, org_id, platform, text, status, issues, connection_id, scheduled_at) VALUES (?, ?, 'bluesky', 'Due now', 'scheduled', '[]', ?, ?)").bind(due, u.orgId, conn, Date.now() - 60_000).run();
    const approved = `drf_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO draft (id, org_id, platform, text, status, issues, connection_id) VALUES (?, ?, 'bluesky', 'Ready', 'approved', '[]', ?)").bind(approved, u.orgId, conn).run();

    await pauseWorkspace(createDb(env.DB), u.orgId, { reason: "Internal note about spam", by: "owner@example.com" });
    // The scheduler leaves its posts waiting (not failed), and never contacts the platform.
    let contacted = false;
    await runDuePublishing({ ...deps, fetch: (async () => ((contacted = true), new Response("{}"))) as typeof fetch }, new Date(), 500);
    expect(contacted).toBe(false);
    expect((await env.DB.prepare("SELECT status FROM draft WHERE id = ?").bind(due).first<{ status: string }>())!.status).toBe("scheduled");
    // "Publish now" and scheduling are refused with a clear message.
    const now = await u.call("POST", `/drafts/${approved}/publish`, { connectionId: conn });
    expect(((await now.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "paused", message: expect.stringContaining("paused by Showrium") });
    const sched = await u.call("POST", `/drafts/${approved}/schedule`, { connectionId: conn, at: new Date(Date.now() + 86_400_000).toISOString() });
    expect(((await sched.json()) as { error: { code: string } }).error.code).toBe("paused");
    // Automation doesn't run.
    expect(await runAutopilotFor(createDb(env.DB), [fakeProvider(() => "{}")], u.orgId)).toEqual({ skipped: "paused" });
    // The workspace sees that it's paused, never the staff's internal reason.
    const me = await (await u.call("GET", "/me")).text();
    expect(JSON.parse(me).workspace.paused).toBe(true);
    expect(me).not.toContain("Internal note");
    // Nothing was deleted.
    expect((await env.DB.prepare("SELECT count(*) AS n FROM draft WHERE org_id = ?").bind(u.orgId).first<{ n: number }>())!.n).toBe(2);

    await resumeWorkspace(createDb(env.DB), u.orgId);
    expect(((await (await u.call("GET", "/me")).json()) as { workspace: { paused: boolean } }).workspace.paused).toBe(false);
    const ok = async (url: string) => (url.includes("createSession") ? Response.json({ accessJwt: "j", did: "did:plc:p2", handle: "p2" }) : url.includes("createRecord") ? Response.json({ uri: "at://did:plc:p2/app.bsky.feed.post/1", cid: "c" }) : new Response("{}", { status: 404 }));
    expect(await publishDraft({ ...deps, fetch: ok as typeof fetch }, { orgId: u.orgId, draftId: approved })).toMatchObject({ status: "published" });
  });
});
