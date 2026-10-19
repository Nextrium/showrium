import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb } from "@nextrium/db";
import { estimateNarration, estimateTranscription, importTokenKey, pauseWorkspace, publishDraft, resumeWorkspace, runAutopilotFor, runDuePublishing, saveConnection, type PublishDeps } from "@nextrium/core";
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
