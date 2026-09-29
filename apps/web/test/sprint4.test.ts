import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb } from "@nextrium/db";
import { getBalance, getUsage, importTokenKey, postCreditTxn, publishDraft, PublishError, saveConnection, type PublishDeps } from "@nextrium/core";
import { lintThread } from "@nextrium/policy";
import { x } from "@nextrium/platforms";

const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.17.${Math.floor(++n / 250)}.${n % 250}`;

async function user(email: string, platforms: string[] = ["bluesky", "x", "linkedin", "mastodon"]) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() },
    body: JSON.stringify({ email, name: "S4", password: "correct-horse-battery" }),
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
  const row = await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>();
  return { call, orgId: me.workspace.id, userId: row!.id };
}
type U = Awaited<ReturnType<typeof user>>;
type D = { id: string; platform: string; text: string; parts: string[] | null; partsPosted: number; issues: { code: string; severity: string; message: string }[] };

async function write(u: U, platforms: string[], thread = false) {
  const ctx = (await (await u.call("POST", "/contexts", { kind: "manual", body: "We shipped retries with backoff and jitter today." })).json()) as { id: string };
  return ((await (await u.call("POST", "/compose", { contextItemId: ctx.id, mode: "teach", platforms, thread })).json()) as { drafts: D[] }).drafts;
}

/** A fake network for Bluesky, X and Mastodon that records what was sent. Fails the Nth post when asked. */
function net(opts: { failPost?: number; xSubscription?: string; start?: number } = {}) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  let posts = opts.start ?? 0;
  const fetch = async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.endsWith("createSession")) return Response.json({ accessJwt: "jwt", did: "did:plc:s4", handle: "s4.bsky.social" });
    if (url.includes("/2/users/me")) return Response.json({ data: { id: "99", username: "s4", subscription_type: opts.xSubscription ?? "Premium" } });
    posts++;
    if (opts.failPost && posts - (opts.start ?? 0) === opts.failPost) return new Response("{}", { status: 503 });
    sent.push({ url, body });
    if (url.endsWith("createRecord")) return Response.json({ uri: `at://did:plc:s4/app.bsky.feed.post/p${posts}`, cid: `cid${posts}` });
    if (url.endsWith("/2/tweets")) return Response.json({ data: { id: `t${posts}` } });
    if (url.endsWith("/api/v1/statuses")) return Response.json({ id: `m${posts}`, url: `https://mastodon.social/@s4/m${posts}` });
    return new Response("{}", { status: 404 });
  };
  return { sent, fetch };
}
async function deps(fake: ReturnType<typeof net>): Promise<PublishDeps> {
  return { db: createDb(env.DB), key: await importTokenKey(env.TOKEN_ENCRYPTION_KEY), configs: { mastodonRedirectUri: `${BASE}/cb`, x: { clientId: "id", clientSecret: "s", redirectUri: `${BASE}/cb` } }, fetch: fake.fetch };
}
async function connect(d: PublishDeps, u: U, platform: "bluesky" | "x" | "mastodon", meta: Record<string, string> = {}) {
  const secret = platform === "bluesky" ? { identifier: "s4.bsky.social", appPassword: "aaaa-bbbb-cccc-dddd" } : { tokens: { accessToken: "tok" } };
  return saveConnection(d, { orgId: u.orgId, platform, account: { accountId: platform === "x" ? "99" : "did:plc:s4", handle: "@s4" }, secret, meta: platform === "mastodon" ? { instance: "mastodon.social", ...meta } : meta, userId: u.userId });
}
async function approveWith(u: U, draftId: string, connId: string) {
  expect((await u.call("PATCH", `/drafts/${draftId}`, { status: "approved" })).status).toBe(200);
  await env.DB.prepare("UPDATE draft SET connection_id = ? WHERE id = ?").bind(connId, draftId).run();
}

describe("threads: writing and editing", () => {
  it("checks each part on its own", () => {
    expect(lintThread("bluesky", ["ok part one", "b".repeat(301), ""]).map((i) => i.message)).toEqual(["Part 2: Bluesky allows 300 characters; this is 301.", "Part 3 is empty."]);
    expect(lintThread("x", Array.from({ length: 21 }, () => "part")).some((i) => /up to 20 parts/.test(i.message))).toBe(true);
  });

  it("writes threads only where platforms support them", async () => {
    const u = await user("s4-write@example.com");
    const drafts = await write(u, ["bluesky", "x", "linkedin"], true);
    const by = Object.fromEntries(drafts.map((d) => [d.platform, d]));
    expect(by.bluesky!.parts).toHaveLength(3);
    expect(by.x!.parts).toHaveLength(3);
    expect(by.linkedin!.parts).toBeNull();
    expect(by.bluesky!.text).toBe(by.bluesky!.parts!.join("\n\n"));
  });

  it("edits parts, turns a thread back into one post, and refuses threads where they don't exist", async () => {
    const u = await user("s4-edit@example.com");
    const [bsky, li] = await write(u, ["bluesky", "linkedin"]);
    const edited = ((await (await u.call("PATCH", `/drafts/${bsky!.id}`, { parts: ["First part.", "c".repeat(301)] })).json()) as { draft: D }).draft;
    expect(edited.parts).toEqual(["First part.", "c".repeat(301)]);
    expect(edited.issues.some((i) => i.message.startsWith("Part 2:") && i.severity === "error")).toBe(true);
    expect((await u.call("PATCH", `/drafts/${bsky!.id}`, { status: "approved" })).status).toBe(409); // errors block approval
    const single = ((await (await u.call("PATCH", `/drafts/${bsky!.id}`, { text: "Just one post now." })).json()) as { draft: D }).draft;
    expect(single).toMatchObject({ parts: null, text: "Just one post now." });
    expect((await u.call("PATCH", `/drafts/${li!.id}`, { parts: ["a", "b"] })).status).toBe(409);
  });
});

describe("threads: publishing", () => {
  it("posts a Bluesky thread as a reply chain, and a retry continues where it stopped", async () => {
    const u = await user("s4-bsky@example.com");
    const [t] = await write(u, ["bluesky"], true);
    const failing = net({ failPost: 2 });
    const d1 = await deps(failing);
    const conn = await connect(d1, u, "bluesky");
    await approveWith(u, t!.id, conn);
    const err = (await publishDraft(d1, { orgId: u.orgId, draftId: t!.id }).catch((e: unknown) => e)) as PublishError;
    expect(err).toBeInstanceOf(PublishError);
    expect(err.message).toMatch(/^Posted 1 of 3 parts\./);
    const mid = await env.DB.prepare("SELECT status, posted_parts FROM draft WHERE id = ?").bind(t!.id).first<{ status: string; posted_parts: string }>();
    expect(mid!.status).toBe("failed");
    expect(JSON.parse(mid!.posted_parts)).toHaveLength(1);

    const ok = net({ start: 10 });
    await publishDraft(await deps(ok), { orgId: u.orgId, draftId: t!.id });
    // Only the two missing parts were sent, each replying to the one before, all under the first.
    expect(ok.sent).toHaveLength(2);
    const [second, third] = ok.sent.map((s) => (s.body.record as { reply: { root: { uri: string }; parent: { uri: string; cid: string } } }).reply);
    expect(second).toEqual({ root: { uri: "at://did:plc:s4/app.bsky.feed.post/p1", cid: "cid1" }, parent: { uri: "at://did:plc:s4/app.bsky.feed.post/p1", cid: "cid1" } });
    expect(third).toEqual({ root: { uri: "at://did:plc:s4/app.bsky.feed.post/p1", cid: "cid1" }, parent: { uri: "at://did:plc:s4/app.bsky.feed.post/p11", cid: "cid11" } });
    const done = await env.DB.prepare("SELECT status, external_post_id FROM draft WHERE id = ?").bind(t!.id).first<{ status: string; external_post_id: string }>();
    expect(done).toEqual({ status: "published", external_post_id: "at://did:plc:s4/app.bsky.feed.post/p1" });
  });

  it("X threads reply in order, cost credits per part beyond the plan, and refund parts that didn't go out", async () => {
    const u = await user("s4-x@example.com");
    const [t] = await write(u, ["x"], true);
    const fake = net({ failPost: 3 });
    const d = await deps(fake);
    const conn = await connect(d, u, "x");
    await approveWith(u, t!.id, conn);
    await postCreditTxn(d.db, { orgId: u.orgId, kind: "purchase", amount: 100, idempotencyKey: `topup:${u.orgId}`, description: "Pack" });
    const before = await getBalance(d.db, u.orgId);
    await expect(publishDraft(d, { orgId: u.orgId, draftId: t!.id })).rejects.toBeInstanceOf(PublishError);
    // Free plan: no X allowance, 2 credits per part. 3 charged, 1 part failed → 1 refunded.
    expect(before - (await getBalance(d.db, u.orgId))).toBe(4);
    expect((await getUsage(d.db, u.orgId)).xApiPosts).toBe(2);
    expect(fake.sent.map((s) => s.body.reply)).toEqual([undefined, { in_reply_to_tweet_id: "t1" }]);
  });

  it("Mastodon threads reply with in_reply_to_id", async () => {
    const u = await user("s4-masto@example.com");
    const [t] = await write(u, ["mastodon"], true);
    const fake = net();
    const d = await deps(fake);
    await approveWith(u, t!.id, await connect(d, u, "mastodon"));
    await publishDraft(d, { orgId: u.orgId, draftId: t!.id });
    expect(fake.sent.map((s) => s.body.in_reply_to_id)).toEqual([undefined, "m1", "m2"]);
  });

  it("tap-to-post opens the first part", async () => {
    const u = await user("s4-intent@example.com");
    const [t] = await write(u, ["x"], true);
    const out = (await (await u.call("GET", `/drafts/${t!.id}/intent`)).json()) as { url: string };
    expect(decodeURIComponent(out.url.split("text=")[1]!)).toBe(t!.parts![0]);
  });
});

describe("X Premium long posts", () => {
  it("reads the subscription safely", async () => {
    const acct = await x.account({ accessToken: "t" }, async () => Response.json({ data: { id: "1", username: "a", subscription_type: "PremiumPlus" } }));
    expect(acct.subscription).toBe("PremiumPlus");
    const odd = await x.account({ accessToken: "t" }, async () => Response.json({ data: { id: "1", username: "a", subscription_type: "<script>" } }));
    expect(odd.subscription).toBe("None");
  });

  it("allows long X posts only with Premium, and re-checks before posting one", async () => {
    const u = await user("s4-long@example.com", ["x"]);
    const [post] = await write(u, ["x"]);
    const long = "A long post. ".repeat(60); // ~780 characters
    const issues = async () => ((await (await u.call("PATCH", `/drafts/${post!.id}`, { text: long })).json()) as { draft: D }).draft.issues;
    expect((await issues()).some((i) => i.code === "too_long")).toBe(true);

    const premium = net({ xSubscription: "None" }); // the account lost Premium since connecting
    const d = await deps(premium);
    const conn = await connect(d, u, "x", { subscription: "Premium" });
    expect((await issues()).some((i) => i.code === "too_long")).toBe(false);
    const list = (await (await u.call("GET", "/connections")).json()) as { data: { longPosts: boolean }[] };
    expect(list.data[0]!.longPosts).toBe(true);

    await approveWith(u, post!.id, conn);
    await postCreditTxn(d.db, { orgId: u.orgId, kind: "purchase", amount: 50, idempotencyKey: `topup:${u.orgId}`, description: "Pack" });
    const err = (await publishDraft(d, { orgId: u.orgId, draftId: post!.id }).catch((e: unknown) => e)) as PublishError;
    expect(err.message).toMatch(/doesn't have Premium any more/);
    expect(premium.sent).toHaveLength(0); // nothing was posted
    const meta = await env.DB.prepare("SELECT meta FROM connection WHERE id = ?").bind(conn).first<{ meta: string }>();
    expect(JSON.parse(meta!.meta).subscription).toBe("None");
  });
});
