import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb } from "@nextrium/db";
import { compose, createIdeas, importTokenKey, judgeRelevance, matchesWords, MEANING_MARGIN_MIN, ownSource, saveConnection, SMALL_TALK, syncSource, xReader, type Embedder, type PublishDeps } from "@nextrium/core";
import { composeUserPrompt, fakeProvider, type Provider } from "@nextrium/llm";

// Is a passion's item about the passion? Its words and its meaning are checked side by side, and either
// is enough (owner decision 2026-10-25): a passion's name is rarely in every good article about it.
// A passion can list the X accounts of several organisations. Writing time and fallbacks are recorded.
const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.61.${Math.floor(++n / 250)}.${n % 250}`;

async function user(email: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() }, body: JSON.stringify({ email, name: "R", password: "correct-horse-battery" }) });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = (method: string, path: string, body?: unknown) =>
    SELF.fetch(`${BASE}/api/v1${path}`, { method, headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  await call("PUT", "/persona", { displayName: "R", platforms: ["linkedin", "x"] });
  const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string } };
  await env.DB.prepare("UPDATE org SET plan = 'creator' WHERE id = ?").bind(me.workspace.id).run();
  const userId = (await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>())!.id;
  return { call, orgId: me.workspace.id, userId };
}

/**
 * A stand-in for the embedding model: three dimensions (security, small talk, anything else). The
 * passion's name lands on "security", the small-talk anchors on "small talk", items by their words.
 */
function fakeEmbedder(calls: string[][] = []): Embedder {
  return async (texts) => {
    calls.push(texts);
    return texts.map((t) => {
      if (SMALL_TALK.includes(t)) return [0, 1, 0];
      if (/security|ransomware|zero-day|phishing/i.test(t)) return [1, 0, 0.1];
      if (/movie|football|dinner/i.test(t)) return [0, 1, 0.1];
      return [0.2, 0.2, 1];
    });
  };
}
const SECURITY = { name: "CyberSecurity", topics: [] as string[], handles: [] as string[], relation: "follow" as const };
const NEWS = { kind: "rss", key: "https://example.com/feed.xml" };

describe("words and meaning, side by side", () => {
  it("the meaning catches what the words miss, and the words catch what the meaning misses", async () => {
    const calls: string[][] = [];
    const items = [{ title: "New ransomware strain hits hospitals" }, { title: "Excited to see this movie" }, { title: "Quarterly update from the CyberSecurity alliance" }];
    const out = await judgeRelevance(SECURITY, NEWS, items, fakeEmbedder(calls));
    expect(out.map((o) => o.match)).toEqual(["meaning", "none", "both"]);
    expect(out[0]!.margin!).toBeGreaterThanOrEqual(MEANING_MARGIN_MIN);
    expect(out[1]!.margin!).toBeLessThan(MEANING_MARGIN_MIN);
    // One call for the whole batch: the passion, the small-talk anchors and every item.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1 + SMALL_TALK.length + items.length);
  });

  it("if the model is down, the words still decide (it never blocks or throws)", async () => {
    const broken: Embedder = async () => {
      throw new Error("AI unavailable");
    };
    const out = await judgeRelevance({ ...SECURITY, topics: ["zero-day"] }, NEWS, [{ title: "Vendor patches a zero-day" }, { title: "Ransomware news" }], broken);
    expect(out).toEqual([
      { match: "words", margin: null },
      { match: "none", margin: null },
    ]);
  });

  it("words: the whole name, any topic, any X account, or all the main words of a longer name", () => {
    const ai = { name: "AI and Machine Learning Ecosystem", topics: ["LLM"], handles: ["someLab"] };
    expect(matchesWords("Notes on machine learning at scale", ai)).toBe(true);
    expect(matchesWords("A new LLM benchmark", ai)).toBe(true);
    expect(matchesWords("Thread by @somelab on training", ai)).toBe(true);
    expect(matchesWords("Learning to cook rice", ai)).toBe(false); // one word of the name isn't enough
    expect(matchesWords("A football result", ai)).toBe(false);
  });

  it("a passion's own sources are always on-topic, without asking the model", async () => {
    const calls: string[][] = [];
    expect(ownSource({ relation: "ours", handles: [] }, NEWS)).toBe(true);
    expect(ownSource({ relation: "follow", handles: [] }, { kind: "github_repo", key: "org/repo" })).toBe(true);
    expect(ownSource({ relation: "follow", handles: ["SomeLab"] }, { kind: "x_account", key: "somelab" })).toBe(true);
    expect(ownSource({ relation: "follow", handles: ["SomeLab"] }, { kind: "x_account", key: "someone_else" })).toBe(false);
    const out = await judgeRelevance({ ...SECURITY, relation: "ours" }, NEWS, [{ title: "Our team's new blog post" }], fakeEmbedder(calls));
    expect(out).toEqual([{ match: "own", margin: null }]);
    expect(calls).toHaveLength(0);
  });
});

describe("ideas from a passion", () => {
  it("an on-topic item that never names the passion is kept; small talk is set aside; how it was judged is stored", async () => {
    const u = await user("pr-ideas@example.com");
    const db = createDb(env.DB);
    const p = (await (await u.call("POST", "/passions", { name: "CyberSecurity" })).json()) as { id: string };
    const src = `src_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO source (id, org_id, kind, key, passion_id) VALUES (?, ?, 'rss', ?, ?)").bind(src, u.orgId, `https://example.com/${src}.xml`, p.id).run();
    const ids: string[] = [];
    for (const title of ["New ransomware strain hits hospitals", "Excited to see this movie"]) {
      const id = `ctx_${crypto.randomUUID()}`;
      ids.push(id);
      await env.DB.prepare("INSERT INTO context_item (id, org_id, source_id, kind, title, body, external_id) VALUES (?, ?, ?, 'rss_item', ?, '', ?)").bind(id, u.orgId, src, title, `ext-${id}`).run();
    }
    const verdicts = await judgeRelevance(SECURITY, NEWS, [{ title: "New ransomware strain hits hospitals" }, { title: "Excited to see this movie" }], fakeEmbedder());
    await createIdeas(db, u.orgId, "rss_item", ids.map((id, k) => ({ id, title: k ? "Excited to see this movie" : "New ransomware strain hits hospitals", publishedAt: new Date(), match: verdicts[k]!.match, margin: verdicts[k]!.margin })), "CyberSecurity", { passionName: "CyberSecurity" });
    const rows = await env.DB.prepare("SELECT c.title, i.status, i.topic_match, i.relevance FROM idea i JOIN context_item c ON c.id = i.context_item_id WHERE i.org_id = ? ORDER BY c.title").bind(u.orgId).all<{ title: string; status: string; topic_match: string; relevance: number | null }>();
    const byTitle = Object.fromEntries(rows.results.map((r) => [r.title, r]));
    expect(byTitle["New ransomware strain hits hospitals"]).toMatchObject({ status: "new", topic_match: "meaning" });
    expect(byTitle["Excited to see this movie"]).toMatchObject({ status: "dismissed", topic_match: "none" });
    expect(byTitle["New ransomware strain hits hospitals"]!.relevance).not.toBeNull();
  });

  it("a source check records the meaning check's cost (estimated) and judges each new item", async () => {
    const u = await user("pr-sync@example.com");
    const p = (await (await u.call("POST", "/passions", { name: "CyberSecurity" })).json()) as { id: string };
    const src = `src_${crypto.randomUUID()}`;
    const feedUrl = `https://example.com/${src}.xml`;
    await env.DB.prepare("INSERT INTO source (id, org_id, kind, key, passion_id, last_checked_at) VALUES (?, ?, 'rss', ?, ?, ?)").bind(src, u.orgId, feedUrl, p.id, Date.now() - 86_400_000).run();
    const now = new Date().toUTCString();
    const feed = `<?xml version="1.0"?><rss><channel><title>t</title><item><title>Phishing kit targets bank customers</title><link>https://example.com/a</link><guid>a-${src}</guid><pubDate>${now}</pubDate></item><item><title>Dinner plans for Friday</title><link>https://example.com/b</link><guid>b-${src}</guid><pubDate>${now}</pubDate></item></channel></rss>`;
    const fakeFetch = (async () => new Response(feed, { headers: { "Content-Type": "application/rss+xml" } })) as typeof fetch;
    const row = (await env.DB.prepare("SELECT * FROM source WHERE id = ?").bind(src).first())!;
    const source = { ...row, orgId: row.org_id, passionId: row.passion_id, lastCheckedAt: new Date(row.last_checked_at as number), seen: [], lastError: null } as never;
    const out = await syncSource(createDb(env.DB), source, { fetch: fakeFetch, embed: fakeEmbedder() });
    expect(out).toMatchObject({ added: 2, error: null });
    const ideas = await env.DB.prepare("SELECT c.title, i.status, i.topic_match FROM idea i JOIN context_item c ON c.id = i.context_item_id WHERE i.org_id = ?").bind(u.orgId).all<{ title: string; status: string; topic_match: string }>();
    expect(ideas.results.find((r) => r.title.startsWith("Phishing"))).toMatchObject({ status: "new", topic_match: "meaning" });
    expect(ideas.results.find((r) => r.title.startsWith("Dinner"))).toMatchObject({ status: "dismissed", topic_match: "none" });
    const cost = await env.DB.prepare("SELECT model, estimated FROM ai_usage WHERE org_id = ? AND feature = 'relevance'").bind(u.orgId).first();
    expect(cost).toEqual({ model: "@cf/baai/bge-m3", estimated: 1 });
  });
});

describe("a passion's X accounts and topics", () => {
  it("several X accounts (cleaned, without repeats, up to 10) and topics (up to 20); the older single field still works", async () => {
    const u = await user("pr-handles@example.com");
    const p = (await (await u.call("POST", "/passions", { name: "AI and Machine Learning" })).json()) as { id: string };
    expect((await u.call("PATCH", `/passions/${p.id}`, { xHandles: ["@LabOne", "https://x.com/labtwo/status/1", "labone"], topics: [" LLM ", "inference", "llm"] })).status).toBe(200);
    let list = (await (await u.call("GET", "/passions")).json()) as { data: { xHandle: string; xHandles: string[]; topics: string[] }[] };
    expect(list.data[0]).toMatchObject({ xHandles: ["LabOne", "labtwo"], xHandle: "LabOne", topics: ["LLM", "inference"] });
    expect((await u.call("PATCH", `/passions/${p.id}`, { xHandles: Array.from({ length: 11 }, (_, i) => `@lab${i}`) })).status).toBe(400);
    expect((await u.call("PATCH", `/passions/${p.id}`, { xHandles: ["not a handle!"] })).status).toBe(400);
    expect((await u.call("PATCH", `/passions/${p.id}`, { topics: ["x".repeat(41)] })).status).toBe(400);
    // The older single field replaces the list with one account.
    expect((await u.call("PATCH", `/passions/${p.id}`, { xHandle: "@solo" })).status).toBe(200);
    list = (await (await u.call("GET", "/passions")).json()) as { data: { xHandle: string; xHandles: string[]; topics: string[] }[] };
    expect(list.data[0]).toMatchObject({ xHandle: "solo", xHandles: ["solo"] });
  });

  it("the writer may mention only the account the material is about, on X only", () => {
    const base = { mode: "teach" as const, contextTitle: "t", contextBody: "b", stance: "other" as const };
    const many = composeUserPrompt({ ...base, platforms: ["x", "linkedin"], passion: { name: "AI", about: "", disclosure: "", relation: "follow", xHandles: ["labone", "labtwo"] } });
    expect(many).toContain("only the one whose organisation this material is actually about: @labone, @labtwo");
    expect(many).toContain("If the material isn't about any of them, mention none.");
    const noX = composeUserPrompt({ ...base, platforms: ["linkedin"], passion: { name: "AI", about: "", disclosure: "", relation: "follow", xHandles: ["labone", "labtwo"] } });
    expect(noX).not.toContain("@labone");
  });
});

describe("X sign-in refused while reading", () => {
  it("the account shows as needing reconnecting, not still connected", async () => {
    const u = await user("pr-xread@example.com");
    const d: PublishDeps = { db: createDb(env.DB), key: await importTokenKey(env.TOKEN_ENCRYPTION_KEY), configs: { mastodonRedirectUri: `${BASE}/cb`, x: { clientId: "c", clientSecret: "s", redirectUri: `${BASE}/cb` } } };
    await saveConnection(d, { orgId: u.orgId, platform: "x", account: { accountId: "x-read", handle: "@read" }, secret: { tokens: { accessToken: "old", refreshToken: "dead", expiresAt: Date.now() - 60_000 } }, meta: {}, userId: u.userId });
    const refused = (async () => Response.json({ error: "invalid_request", error_description: "Value passed for the token was invalid." }, { status: 400 })) as typeof fetch;
    await expect(xReader({ ...d, fetch: refused })(u.orgId)).rejects.toThrow(/sign in again/);
    const conn = await env.DB.prepare("SELECT status FROM connection WHERE org_id = ? AND platform = 'x'").bind(u.orgId).first<{ status: string }>();
    expect(conn!.status).toBe("needs_reconnect");
  });
});

describe("writing time and fallbacks are recorded", () => {
  it("how long writing took, and why a fallback model answered", async () => {
    const u = await user("pr-speed@example.com");
    const ctx = `ctx_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO context_item (id, org_id, kind, title, body) VALUES (?, ?, 'manual', 'Shipped retries', 'Backoff and jitter.')").bind(ctx, u.orgId).run();
    const failing: Provider = { name: "first-model", price: { input: 0, output: 0 }, generate: async () => Promise.reject(new Error("HTTP 503")) };
    const writer = fakeProvider(() => JSON.stringify({ angle: "a", key_points: ["k"], variants: [{ platform: "linkedin", text: "Retries now back off with jitter, so a failing job no longer floods the queue." }] }), "second-model");
    await compose(createDb(env.DB), [failing, writer], { orgId: u.orgId, contextItemId: ctx, mode: "teach", platforms: ["linkedin"] });
    const row = await env.DB.prepare("SELECT model, duration_ms, fallback FROM ai_usage WHERE org_id = ? AND feature = 'write'").bind(u.orgId).first<{ model: string; duration_ms: number; fallback: string }>();
    expect(row!.model).toBe("second-model");
    expect(row!.duration_ms).toBeGreaterThanOrEqual(0);
    expect(row!.fallback).toBe("first-model: HTTP 503");
  });
});
