import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb } from "@nextrium/db";
import { importTokenKey, publishDraft, saveConnection, type PublishDeps } from "@nextrium/core";

// LinkedIn: the source link goes in the first comment, because a link in the post hides its image
// (owner decision 2026-10-21). The post goes out first; a refused comment never fails it.
const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.56.${Math.floor(++n / 250)}.${n % 250}`;

async function setup(email: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() }, body: JSON.stringify({ email, name: "L", password: "correct-horse-battery" }) });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = (method: string, path: string, body?: unknown) =>
    SELF.fetch(`${BASE}/api/v1${path}`, { method, headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  await call("PUT", "/persona", { displayName: "L", platforms: ["linkedin"] });
  const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string } };
  const userId = (await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>())!.id;
  const deps: PublishDeps = { db: createDb(env.DB), key: await importTokenKey(env.TOKEN_ENCRYPTION_KEY), configs: { mastodonRedirectUri: `${BASE}/cb` } };
  const conn = await saveConnection(deps, { orgId: me.workspace.id, platform: "linkedin", account: { accountId: "li-123", handle: "Me" }, secret: { tokens: { accessToken: "t", expiresAt: Date.now() + 3600_000 } }, meta: {}, userId });
  const id = `drf_${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO draft (id, org_id, platform, text, status, issues, connection_id, link_comment) VALUES (?, ?, 'linkedin', 'Good news for builders. Link in the comments 👇', 'approved', '[]', ?, 'https://github.com/a/b')").bind(id, me.workspace.id, conn).run();
  return { call, deps, orgId: me.workspace.id, id };
}

describe("LinkedIn's first comment", () => {
  it("posts the link as a comment on the new post, from the same member", async () => {
    const s = await setup("lc-ok@example.com");
    const calls: { url: string; body: string }[] = [];
    const fake = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body ?? "") });
      if (url.endsWith("/rest/posts")) return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:777" } });
      if (url.includes("/rest/socialActions/")) return Response.json({}, { status: 201 });
      return new Response("{}", { status: 404 });
    };
    expect(await publishDraft({ ...s.deps, fetch: fake as typeof fetch }, { orgId: s.orgId, draftId: s.id })).toMatchObject({ status: "published" });
    const post = calls.find((c) => c.url.endsWith("/rest/posts"))!;
    expect(post.body).not.toContain("https://github.com/a/b"); // the post itself has no link
    const comment = calls.find((c) => c.url.includes("/socialActions/"))!;
    expect(comment.url).toBe(`https://api.linkedin.com/rest/socialActions/${encodeURIComponent("urn:li:share:777")}/comments`);
    expect(JSON.parse(comment.body)).toEqual({ actor: "urn:li:person:li-123", object: "urn:li:share:777", message: { text: "https://github.com/a/b" } });
    expect(calls.indexOf(post)).toBeLessThan(calls.indexOf(comment)); // the post first
    expect((await env.DB.prepare("SELECT last_error FROM draft WHERE id = ?").bind(s.id).first<{ last_error: string | null }>())!.last_error).toBeNull();
    // Shown in the app.
    const shown = (await (await s.call("GET", `/drafts/${s.id}`)).json()) as { draft: { linkComment: string } };
    expect(shown.draft.linkComment).toBe("https://github.com/a/b");
  });

  it("a refused comment leaves the post published, with a note to add the link yourself", async () => {
    const s = await setup("lc-refused@example.com");
    const fake = async (url: string) =>
      url.endsWith("/rest/posts") ? new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:888" } }) : url.includes("/socialActions/") ? Response.json({ message: "Comments are closed" }, { status: 422 }) : new Response("{}", { status: 404 });
    expect(await publishDraft({ ...s.deps, fetch: fake as typeof fetch }, { orgId: s.orgId, draftId: s.id })).toMatchObject({ status: "published" });
    const row = (await env.DB.prepare("SELECT status, last_error FROM draft WHERE id = ?").bind(s.id).first<{ status: string; last_error: string }>())!;
    expect(row.status).toBe("published");
    expect(row.last_error).toContain("The link comment didn't go out");
    expect(row.last_error).toContain("https://github.com/a/b");
  });
});
