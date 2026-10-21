import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb } from "@nextrium/db";
import { importTokenKey, saveConnection, socialSource, syncSource, xReader, type PublishDeps } from "@nextrium/core";

// Social sites are read only the way their terms allow (owner decision 2026-10-21): an X account
// through X's API with the workspace's X sign-in, Bluesky through its RSS, the others not at all.
const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.53.${Math.floor(++n / 250)}.${n % 250}`;

async function user(email: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() }, body: JSON.stringify({ email, name: "S", password: "correct-horse-battery" }) });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = (method: string, path: string, body?: unknown) =>
    SELF.fetch(`${BASE}/api/v1${path}`, { method, headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  await call("PUT", "/persona", { displayName: "S", platforms: ["linkedin", "x"] });
  const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string } };
  await env.DB.prepare("UPDATE org SET plan = 'creator' WHERE id = ?").bind(me.workspace.id).run();
  const row = await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>();
  const passion = (await (await call("POST", "/passions", { name: "Cardano" })).json()) as { id: string };
  return { call, orgId: me.workspace.id, userId: row!.id, passionId: passion.id };
}
const deps = async (): Promise<PublishDeps> => ({ db: createDb(env.DB), key: await importTokenKey(env.TOKEN_ENCRYPTION_KEY), configs: { mastodonRedirectUri: `${BASE}/cb` } });
async function connectX(u: Awaited<ReturnType<typeof user>>) {
  await saveConnection(await deps(), { orgId: u.orgId, platform: "x", account: { accountId: `x-${u.orgId}`, handle: "@me" }, secret: { tokens: { accessToken: "a1", refreshToken: "r1", expiresAt: Date.now() + 3600_000 } }, meta: {}, userId: u.userId });
}

describe("which social addresses can be read", () => {
  it("knows X accounts, Bluesky profiles and the sites that can't be read", () => {
    expect(socialSource("https://x.com/IOHK_Charles")).toEqual({ kind: "x_account", handle: "iohk_charles" });
    expect(socialSource("twitter.com/Cardano/status/123")).toEqual({ kind: "x_account", handle: "cardano" });
    expect(socialSource("https://mobile.x.com/F_Gregaard")).toEqual({ kind: "x_account", handle: "f_gregaard" });
    expect(socialSource("https://x.com/home")).toEqual({ blocked: "X" }); // not an account
    expect(socialSource("https://x.com/search?q=cardano")).toEqual({ blocked: "X" });
    expect(socialSource("https://www.linkedin.com/company/iohk")).toEqual({ blocked: "LinkedIn" });
    expect(socialSource("https://instagram.com/cardano")).toEqual({ blocked: "Instagram" });
    expect(socialSource("https://m.facebook.com/cardano")).toEqual({ blocked: "Facebook" });
    expect(socialSource("https://www.tiktok.com/@cardano")).toEqual({ blocked: "TikTok" });
    expect(socialSource("https://www.threads.net/@cardano")).toEqual({ blocked: "Threads" });
    expect(socialSource("https://bsky.app/profile/cardano.bsky.social")).toEqual({ kind: "rss", key: "https://bsky.app/profile/cardano.bsky.social/rss" });
    // Look-alike hosts are ordinary websites.
    expect(socialSource("https://notx.com/a")).toBeNull();
    expect(socialSource("https://x.com.evil.example/a")).toBeNull();
    expect(socialSource("https://cardano.org/news")).toBeNull();
  });
});

describe("adding social sources", () => {
  it("an X account needs a connected X account; other social pages are refused before anything is fetched", async () => {
    const u = await user("soc-add@example.com");
    const noX = await u.call("POST", `/passions/${u.passionId}/sources`, { kind: "rss", url: "https://x.com/IOHK_Charles" });
    expect(noX.status).toBe(400);
    expect(((await noX.json()) as { error: { message: string } }).error.message).toContain("Connect your X account");
    const li = await u.call("POST", `/passions/${u.passionId}/sources`, { kind: "rss", url: "https://www.linkedin.com/company/iohk" });
    expect(li.status).toBe(400);
    expect(((await li.json()) as { error: { message: string } }).error.message).toContain("LinkedIn's terms don't allow it");
    expect((await u.call("POST", "/sources", { kind: "rss", url: "https://instagram.com/someone" })).status).toBe(400); // own sources too

    await connectX(u);
    const ok = await u.call("POST", `/passions/${u.passionId}/sources`, { kind: "rss", url: "https://x.com/IOHK_Charles" });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ kind: "x_account", key: "iohk_charles" });
    // The same account twice is refused.
    expect((await u.call("POST", `/passions/${u.passionId}/sources`, { kind: "rss", url: "https://twitter.com/iohk_charles" })).status).toBe(409);
  });
});

describe("reading an X account", () => {
  it("reads only new original posts through X's API, records what X charged, and never opens x.com pages", async () => {
    const u = await user("soc-read@example.com");
    await connectX(u);
    // An X profile that was watched as a web page before this change: it moves to the API on its next check.
    const id = `src_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO source (id, org_id, kind, key, passion_id, seen) VALUES (?, ?, 'page', 'https://x.com/IOHK_Charles', ?, '[]')").bind(id, u.orgId, u.passionId).run();
    const asked: string[] = [];
    let round = 1;
    const fakeX = async (url: string) => {
      asked.push(url);
      if (url.includes("/2/users/by/username/iohk_charles")) return Response.json({ data: { id: "42", username: "IOHK_Charles" } });
      if (url.includes("/2/users/42/tweets")) {
        return round === 1
          ? Response.json({ data: [{ id: "1002", text: "Cardano node 10.5 is out\nFaster sync.", created_at: new Date().toISOString() }, { id: "1001", text: "Older news", created_at: new Date().toISOString() }] })
          : Response.json({ meta: { result_count: 0 } });
      }
      return new Response("not found", { status: 404 });
    };
    const d = await deps();
    const src = (await env.DB.prepare("SELECT * FROM source WHERE id = ?").bind(id).first())!;
    const row = { ...src, seen: JSON.parse(String(src.seen)), lastCheckedAt: null, createdAt: new Date(), passionId: u.passionId, orgId: u.orgId, kind: "page", key: "https://x.com/IOHK_Charles" } as never;
    const first = await syncSource(d.db, row, { fetch: fakeX as typeof fetch, xReader: xReader({ ...d, fetch: fakeX as typeof fetch }) });
    expect(first).toMatchObject({ added: 2, error: null });
    expect(asked.some((a) => a.startsWith("https://x.com/"))).toBe(false); // the page itself is never fetched
    expect(asked.find((a) => a.includes("/tweets"))).toContain("exclude=retweets%2Creplies");
    const after = (await env.DB.prepare("SELECT kind, key, seen FROM source WHERE id = ?").bind(id).first<{ kind: string; key: string; seen: string }>())!;
    expect(after).toMatchObject({ kind: "x_account", key: "iohk_charles" });
    expect(JSON.parse(after.seen)).toEqual(["uid:42", "since:1002"]);
    const items = await env.DB.prepare("SELECT title, url FROM context_item WHERE source_id = ? ORDER BY external_id DESC").bind(id).all<{ title: string; url: string }>();
    expect(items.results[0]).toEqual({ title: "Cardano node 10.5 is out", url: "https://x.com/iohk_charles/status/1002" });

    // Next check: no account lookup again, and only posts newer than the last one.
    round = 2;
    asked.length = 0;
    const again = (await env.DB.prepare("SELECT * FROM source WHERE id = ?").bind(id).first())!;
    await syncSource(d.db, { ...again, seen: JSON.parse(String(again.seen)), orgId: u.orgId, kind: "x_account", key: "iohk_charles", passionId: u.passionId } as never, { fetch: fakeX as typeof fetch, xReader: xReader({ ...d, fetch: fakeX as typeof fetch }) });
    expect(asked.some((a) => a.includes("/users/by/username/"))).toBe(false);
    expect(asked.find((a) => a.includes("/tweets"))).toContain("since_id=1002");

    // X's charges: one account lookup ($0.010) and two posts read ($0.005 each).
    const costs = await env.DB.prepare("SELECT kind, count(*) AS n, sum(cost_micro_usd) AS c FROM platform_usage WHERE org_id = ? GROUP BY kind ORDER BY kind").bind(u.orgId).all<{ kind: string; n: number; c: number }>();
    expect(costs.results).toEqual([{ kind: "post_read", n: 2, c: 10000 }, { kind: "user_read", n: 1, c: 10000 }]);
  });

  it("without an X account, or with another social site's page, the check fails clearly and fetches nothing", async () => {
    const u = await user("soc-none@example.com");
    const d = await deps();
    const asked: string[] = [];
    const spy = (async (url: string) => (asked.push(url), new Response("<html></html>", { headers: { "Content-Type": "text/html" } }))) as typeof fetch;
    const base = { id: "", orgId: u.orgId, passionId: u.passionId, seen: [], lastCheckedAt: null, lastError: null, createdAt: new Date() };
    const xs = await syncSource(d.db, { ...base, id: `src_${crypto.randomUUID()}`, kind: "x_account", key: "cardano" } as never, { fetch: spy, xReader: xReader({ ...d, fetch: spy }) });
    expect(xs.error).toContain("Connect your X account");
    const li = await syncSource(d.db, { ...base, id: `src_${crypto.randomUUID()}`, kind: "page", key: "https://www.linkedin.com/company/iohk" } as never, { fetch: spy });
    expect(li.error).toContain("LinkedIn's terms don't allow it");
    expect(asked).toEqual([]);
  });
});
