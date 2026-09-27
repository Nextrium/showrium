import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb } from "@nextrium/db";
import {
  createOAuthState,
  decryptJson,
  EncryptionUnavailableError,
  encryptJson,
  importTokenKey,
  publishDraft,
  PublishError,
  runDuePublishing,
  saveConnection,
  scheduleDraft,
  getBalance,
  postCreditTxn,
  type PublishDeps,
} from "@nextrium/core";
import { blueskyLinkFacets, escapeLinkedIn, intentUrl, PlatformError, x } from "@nextrium/platforms";

const BASE = "http://localhost:5173";
const ORIGIN = { Origin: BASE };
let n = 0;
const ip = () => `10.6.${Math.floor(++n / 250)}.${n % 250}`;

async function user(email: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ORIGIN, "CF-Connecting-IP": ip() },
    body: JSON.stringify({ email, name: email.split("@")[0], password: "correct-horse-battery" }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const me = (await (await SELF.fetch(`${BASE}/api/v1/me`, { headers: { Cookie: cookie } })).json()) as { workspace: { id: string } };
  const row = await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>();
  return { cookie, orgId: me.workspace.id, userId: row!.id };
}
const call = (cookie: string, method: string, path: string, body?: unknown) =>
  SELF.fetch(`${BASE}/api/v1${path}`, {
    method,
    redirect: "manual",
    headers: { Cookie: cookie, ...ORIGIN, "CF-Connecting-IP": ip(), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

/** A workspace with an approved draft for `platform`, ready to publish. */
async function readyDraft(email: string, platform: "bluesky" | "x" | "mastodon" = "bluesky", text = "Shipped retries today.") {
  const u = await user(email);
  await call(u.cookie, "PUT", "/persona", { displayName: "Ada", platforms: [platform] });
  const ctx = (await (await call(u.cookie, "POST", "/contexts", { kind: "manual", body: "We shipped retries with backoff." })).json()) as { id: string };
  const out = (await (await call(u.cookie, "POST", "/compose", { contextItemId: ctx.id, mode: "teach", platforms: [platform] })).json()) as { drafts: { id: string }[] };
  const draftId = out.drafts[0]!.id;
  await call(u.cookie, "PATCH", `/drafts/${draftId}`, { text });
  await call(u.cookie, "PATCH", `/drafts/${draftId}`, { status: "approved" });
  return { ...u, draftId };
}

/** Fake platform network: records calls, answers like Bluesky / X / Mastodon. */
function fakeNet(opts: { fail?: number } = {}) {
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    calls.push(url);
    if (opts.fail) return new Response("{}", { status: opts.fail });
    if (url.endsWith("createSession")) return Response.json({ accessJwt: "jwt", did: "did:plc:abc", handle: "ada.bsky.social" });
    if (url.endsWith("createRecord")) return Response.json({ uri: "at://did:plc:abc/app.bsky.feed.post/3kxyz" });
    if (url.endsWith("/2/tweets")) return Response.json({ data: { id: "1799" } });
    if (url.endsWith("/api/v1/statuses")) return Response.json({ id: "42", url: "https://mastodon.social/@ada/42" });
    return new Response("{}", { status: 404 });
  };
  return { calls, fetch: fetchFn };
}

async function deps(net: ReturnType<typeof fakeNet>): Promise<PublishDeps> {
  return { db: createDb(env.DB), key: await importTokenKey(env.TOKEN_ENCRYPTION_KEY), configs: { mastodonRedirectUri: `${BASE}/cb`, x: { clientId: "id", clientSecret: "s", redirectUri: `${BASE}/cb` } }, fetch: net.fetch };
}

async function connect(d: PublishDeps, u: { orgId: string; userId: string }, platform: "bluesky" | "x" | "mastodon") {
  const secret = platform === "bluesky" ? { identifier: "ada.bsky.social", appPassword: "aaaa-bbbb-cccc-dddd" } : { tokens: { accessToken: "tok" } };
  return saveConnection(d, { orgId: u.orgId, platform, account: { accountId: platform === "x" ? "99" : "did:plc:abc", handle: "@ada" }, secret, meta: platform === "mastodon" ? { instance: "mastodon.social" } : {}, userId: u.userId });
}

describe("token encryption", () => {
  it("round-trips, and refuses a different workspace binding, a tampered value or a wrong key", async () => {
    const key = await importTokenKey(env.TOKEN_ENCRYPTION_KEY);
    const sealed = await encryptJson(key, { t: "secret" }, "org_a:x:1");
    expect(await decryptJson(key, sealed, "org_a:x:1")).toEqual({ t: "secret" });
    await expect(decryptJson(key, sealed, "org_b:x:1")).rejects.toThrow();
    const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
    await expect(decryptJson(key, tampered, "org_a:x:1")).rejects.toThrow();
    const other = await importTokenKey(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))));
    await expect(decryptJson(other, sealed, "org_a:x:1")).rejects.toThrow();
  });
  it("fails closed without a valid key", async () => {
    await expect(importTokenKey(undefined)).rejects.toBeInstanceOf(EncryptionUnavailableError);
    await expect(importTokenKey(btoa("short"))).rejects.toBeInstanceOf(EncryptionUnavailableError);
  });
});

describe("platform helpers", () => {
  it("escapes LinkedIn's reserved characters", () => {
    expect(escapeLinkedIn("Hi (all) @ada #ts [x]")).toBe("Hi \\(all\\) \\@ada \\#ts \\[x\\]");
  });
  it("computes Bluesky link facets in UTF-8 bytes (emoji before the link)", () => {
    const [f] = blueskyLinkFacets("🚀 see https://a.io/x.");
    expect(f!.index).toEqual({ byteStart: 9, byteEnd: 23 });
    expect(f!.features[0]!.uri).toBe("https://a.io/x");
  });
  it("builds tap-to-post links with the text encoded", () => {
    expect(intentUrl("x", "a&b #c")).toBe("https://x.com/intent/post?text=a%26b%20%23c");
    expect(intentUrl("instagram", "hi")).toBeNull();
    expect(intentUrl("mastodon", "hi")).toBeNull();
    expect(intentUrl("mastodon", "hi", { mastodonInstance: "fosstodon.org" })).toBe("https://fosstodon.org/share?text=hi");
  });
  it("maps platform failures to safe, specific errors", async () => {
    const tokens = { accessToken: "t" };
    const acct = { accountId: "1", handle: "@a" };
    for (const [status, kind] of [[401, "auth"], [429, "rate_limited"], [503, "unavailable"], [400, "rejected"]] as const) {
      const err = await x.publish(tokens, acct, "hi", async () => new Response("secret provider detail", { status })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlatformError);
      expect((err as PlatformError).kind).toBe(kind);
      expect((err as PlatformError).message).not.toContain("secret provider detail");
    }
    const net = await x.publish(tokens, acct, "hi", async () => { throw new TypeError("network"); }).catch((e: unknown) => e);
    expect((net as PlatformError).kind).toBe("unavailable");
  });
});

describe("connections API", () => {
  it("never returns secrets, and reports which platforms can be connected", async () => {
    const u = await user("conn1@example.com");
    const d = await deps(fakeNet());
    await connect(d, u, "bluesky");
    const text = await (await call(u.cookie, "GET", "/connections")).text();
    expect(text).toContain("@ada");
    expect(text).not.toContain("aaaa-bbbb");
    expect(text).not.toContain("v1:");
    const body = JSON.parse(text) as { available: string[] };
    expect(body.available).toEqual(expect.arrayContaining(["bluesky", "mastodon"]));
    expect(body.available).not.toContain("x"); // no X app credentials in tests
  });
  it("refuses unconfigured platforms, unsafe Mastodon servers, and non-admins", async () => {
    const u = await user("conn2@example.com");
    expect((await call(u.cookie, "POST", "/connections/x/start", {})).status).toBe(503);
    for (const instance of ["localhost", "127.0.0.1", "printer.local"]) {
      expect((await call(u.cookie, "POST", "/connections/mastodon/start", { instance })).status).toBe(400);
    }
    await env.DB.prepare("UPDATE membership SET role = 'editor' WHERE user_id = ?").bind(u.userId).run();
    expect((await call(u.cookie, "POST", "/connections/mastodon/start", { instance: "mastodon.social" })).status).toBe(403);
  });
  it("rejects a main password pasted instead of a Bluesky app password", async () => {
    const u = await user("conn3@example.com");
    const res = await call(u.cookie, "POST", "/connections/bluesky", { identifier: "ada.bsky.social", appPassword: "MyRealPassword!2024" });
    expect(res.status).toBe(400);
  });
  it("OAuth callback: rejects missing, forged, replayed, other-user and wrong-platform state", async () => {
    const a = await user("cb-a@example.com");
    const b = await user("cb-b@example.com");
    const db = createDb(env.DB);
    const loc = async (res: Response) => { expect(res.status).toBe(302); return res.headers.get("Location")!; };

    expect(await loc(await call(a.cookie, "GET", "/connections/x/callback?code=c"))).toContain("error=cancelled");
    expect(await loc(await call(a.cookie, "GET", "/connections/x/callback?code=c&state=forged"))).toContain("error=invalid_state");

    // State created for user B can't be completed by user A (connection injection).
    const bState = await createOAuthState(db, { orgId: b.orgId, userId: b.userId, platform: "x" });
    expect(await loc(await call(a.cookie, "GET", `/connections/x/callback?code=c&state=${bState.state}`))).toContain("error=invalid_state");
    // ...and the attempt consumed it, so it can't be replayed either.
    expect(await loc(await call(b.cookie, "GET", `/connections/x/callback?code=c&state=${bState.state}`))).toContain("error=invalid_state");

    const aState = await createOAuthState(db, { orgId: a.orgId, userId: a.userId, platform: "linkedin" });
    expect(await loc(await call(a.cookie, "GET", `/connections/x/callback?code=c&state=${aState.state}`))).toContain("error=invalid_state");

    const expired = await createOAuthState(db, { orgId: a.orgId, userId: a.userId, platform: "x" });
    await env.DB.prepare("UPDATE oauth_state SET expires_at = 1 WHERE state = ?").bind(expired.state).run();
    expect(await loc(await call(a.cookie, "GET", `/connections/x/callback?code=c&state=${expired.state}`))).toContain("error=invalid_state");
  });
});

describe("publishing", () => {
  it("publishes an approved Bluesky post and records the link", async () => {
    const u = await readyDraft("pub1@example.com");
    const net = fakeNet();
    const d = await deps(net);
    const connId = await connect(d, u, "bluesky");
    await env.DB.prepare("UPDATE draft SET connection_id = ? WHERE id = ?").bind(connId, u.draftId).run();
    const out = await publishDraft(d, { orgId: u.orgId, draftId: u.draftId });
    expect(out.url).toBe("https://bsky.app/profile/ada.bsky.social/post/3kxyz");
    const row = await env.DB.prepare("SELECT status, external_url, publish_method FROM draft WHERE id = ?").bind(u.draftId).first<Record<string, string>>();
    expect(row).toMatchObject({ status: "published", publish_method: "api" });
  });

  it("can't publish the same post twice, even concurrently", async () => {
    const u = await readyDraft("pub2@example.com");
    const net = fakeNet();
    const d = await deps(net);
    const connId = await connect(d, u, "bluesky");
    await env.DB.prepare("UPDATE draft SET connection_id = ? WHERE id = ?").bind(connId, u.draftId).run();
    const results = await Promise.allSettled([publishDraft(d, { orgId: u.orgId, draftId: u.draftId }), publishDraft(d, { orgId: u.orgId, draftId: u.draftId })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(net.calls.filter((c) => c.endsWith("createRecord"))).toHaveLength(1);
  });

  it("charges credits for X API posts (25 with a link), and refunds when X fails", async () => {
    const u = await readyDraft("pub3@example.com", "x", "Read the notes https://github.com/a/b");
    const d = await deps(fakeNet());
    const connId = await connect(d, u, "x");
    await env.DB.prepare("UPDATE draft SET connection_id = ? WHERE id = ?").bind(connId, u.draftId).run();
    await postCreditTxn(d.db, { orgId: u.orgId, kind: "purchase", amount: 100, idempotencyKey: "topup", description: "Pack" });
    const before = await getBalance(d.db, u.orgId);
    await publishDraft(d, { orgId: u.orgId, draftId: u.draftId });
    expect(before - (await getBalance(d.db, u.orgId))).toBe(25);

    const v = await readyDraft("pub4@example.com", "x", "No link here.");
    const failing = await deps(fakeNet({ fail: 503 }));
    const c2 = await connect(failing, v, "x");
    await env.DB.prepare("UPDATE draft SET connection_id = ? WHERE id = ?").bind(c2, v.draftId).run();
    const b2 = await getBalance(failing.db, v.orgId);
    await expect(publishDraft(failing, { orgId: v.orgId, draftId: v.draftId })).rejects.toBeInstanceOf(PublishError);
    expect(await getBalance(failing.db, v.orgId)).toBe(b2);
    const row = await env.DB.prepare("SELECT status, last_error FROM draft WHERE id = ?").bind(v.draftId).first<Record<string, string>>();
    expect(row!.status).toBe("failed");
    expect(row!.last_error).toMatch(/X is having problems/);
  });

  it("refuses X posts through the API without enough credits", async () => {
    const u = await readyDraft("pub5@example.com", "x", "See https://a.io");
    const d = await deps(fakeNet());
    const connId = await connect(d, u, "x");
    await env.DB.prepare("UPDATE draft SET connection_id = ? WHERE id = ?").bind(connId, u.draftId).run();
    await env.DB.prepare("INSERT INTO credit_txn (id, org_id, kind, idempotency_key, description) VALUES ('txn_b5', ?, 'spend', 'b5', 't')").bind(u.orgId).run();
    await env.DB.prepare("INSERT INTO credit_entry (id, txn_id, org_id, account, amount) VALUES ('e5a','txn_b5',?,'org',-20),('e5b','txn_b5',?,'platform',20)").bind(u.orgId, u.orgId).run();
    const err = await publishDraft(d, { orgId: u.orgId, draftId: u.draftId }).catch((e: unknown) => e);
    expect((err as PublishError).code).toBe("insufficient_credits");
    const row = await env.DB.prepare("SELECT status FROM draft WHERE id = ?").bind(u.draftId).first<{ status: string }>();
    expect(row!.status).toBe("approved"); // released, not stuck in "publishing"
  });

  it("marks the account for reconnection when the platform rejects the token", async () => {
    const u = await readyDraft("pub6@example.com", "mastodon");
    const d = await deps(fakeNet({ fail: 401 }));
    const connId = await connect(d, u, "mastodon");
    await env.DB.prepare("UPDATE draft SET connection_id = ? WHERE id = ?").bind(connId, u.draftId).run();
    await expect(publishDraft(d, { orgId: u.orgId, draftId: u.draftId })).rejects.toBeInstanceOf(PublishError);
    const conn = await env.DB.prepare("SELECT status FROM connection WHERE id = ?").bind(connId).first<{ status: string }>();
    expect(conn!.status).toBe("needs_reconnect");
  });

  it("monetization-safe mode keeps X on tap-to-post", async () => {
    const u = await readyDraft("pub7@example.com", "x");
    await call(u.cookie, "PUT", "/persona", { displayName: "Ada", platforms: ["x"], monetizationSafe: true });
    const d = await deps(fakeNet());
    const connId = await connect(d, u, "x");
    await env.DB.prepare("UPDATE draft SET connection_id = ? WHERE id = ?").bind(connId, u.draftId).run();
    const err = await publishDraft(d, { orgId: u.orgId, draftId: u.draftId }).catch((e: unknown) => e);
    expect((err as PublishError).code).toBe("monetization_safe");
  });

  it("won't publish unapproved posts or use another workspace's account", async () => {
    const a = await readyDraft("pub8a@example.com");
    const b = await readyDraft("pub8b@example.com");
    const d = await deps(fakeNet());
    const bConn = await connect(d, b, "bluesky");
    const res = await call(a.cookie, "POST", `/drafts/${a.draftId}/publish`, { connectionId: bConn });
    expect(res.status).toBe(409);
    await call(a.cookie, "PATCH", `/drafts/${a.draftId}`, { status: "draft" });
    const aConn = await connect(d, a, "bluesky");
    await env.DB.prepare("UPDATE draft SET connection_id = ? WHERE id = ?").bind(aConn, a.draftId).run();
    expect(((await publishDraft(d, { orgId: a.orgId, draftId: a.draftId }).catch((e: unknown) => e)) as PublishError).code).toBe("not_ready");
  });

  it("schedules within limits and the due runner publishes", async () => {
    const u = await readyDraft("pub9@example.com");
    const net = fakeNet();
    const d = await deps(net);
    const connId = await connect(d, u, "bluesky");
    await expect(scheduleDraft(d.db, u.orgId, u.draftId, { at: new Date(Date.now() - 1000), connectionId: connId })).rejects.toThrow(/minute/);
    await expect(scheduleDraft(d.db, u.orgId, u.draftId, { at: new Date(Date.now() + 100 * 86_400_000), connectionId: connId })).rejects.toThrow(/90 days/);
    await scheduleDraft(d.db, u.orgId, u.draftId, { at: new Date(Date.now() + 5 * 60_000), connectionId: connId });
    expect((await runDuePublishing(d, new Date())).due).toBe(0);
    const result = await runDuePublishing(d, new Date(Date.now() + 10 * 60_000));
    expect(result).toMatchObject({ published: 1, failed: 0 });
  });

  it("tap-to-post: link to prefilled composer, then the user marks it posted", async () => {
    const u = await readyDraft("pub10@example.com", "x", "Tap to post me");
    const intent = (await (await call(u.cookie, "GET", `/drafts/${u.draftId}/intent`)).json()) as { url: string };
    expect(intent.url).toBe("https://x.com/intent/post?text=Tap%20to%20post%20me");
    expect((await call(u.cookie, "POST", `/drafts/${u.draftId}/mark-published`, { url: "javascript:alert(1)" })).status).toBe(400);
    expect((await call(u.cookie, "POST", `/drafts/${u.draftId}/mark-published`, { url: "https://x.com/ada/status/1" })).status).toBe(200);
    expect((await call(u.cookie, "POST", `/drafts/${u.draftId}/mark-published`, { url: null })).status).toBe(409);
  });
});
