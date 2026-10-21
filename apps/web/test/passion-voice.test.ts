import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb } from "@nextrium/db";
import { compose, importTokenKey, placeLink, publishDraft, repeatedSentences, repeats, saveConnection, withoutDisclosure, xNeedsTapToPost, type PublishDeps } from "@nextrium/core";
import { composeUserPrompt, fakeProvider } from "@nextrium/llm";

// Owner feedback 2026-10-21: the same background line ("I've been in this ecosystem since 2021…") in
// every passion post; quote and mention official X accounts; X posts with a link, quote or mention
// are always "Post it myself".
const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.57.${Math.floor(++n / 250)}.${n % 250}`;

async function user(email: string, platforms = ["linkedin", "x"]) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() }, body: JSON.stringify({ email, name: "V", password: "correct-horse-battery" }) });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = (method: string, path: string, body?: unknown) =>
    SELF.fetch(`${BASE}/api/v1${path}`, { method, headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  await call("PUT", "/persona", { displayName: "V", platforms });
  const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string } };
  await env.DB.prepare("UPDATE org SET plan = 'creator' WHERE id = ?").bind(me.workspace.id).run();
  const userId = (await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>())!.id;
  return { call, orgId: me.workspace.id, userId };
}
const BACKGROUND = "I've been in this ecosystem since 2021. Seeing something that felt like a sci-fi wish become a working tool on mainnet is genuinely fun.";

describe("the background line isn't repeated", () => {
  it("a sentence used in a recent post is flagged; sentences used twice are shown to the writer to avoid", () => {
    const recent = [`Plutus got faster this week.\n\n${BACKGROUND}`, `Governance votes opened today.\n\n${BACKGROUND}`, "Short one."];
    expect(repeatedSentences(recent)).toEqual(["I've been in this ecosystem since 2021.", "Seeing something that felt like a sci-fi wish become a working tool on mainnet is genuinely fun."]);
    const again = repeats(`Mithril shipped a new release.\n\n${BACKGROUND}`, recent);
    expect(again).toMatchObject({ repeated: true, reason: expect.stringContaining("repeats a sentence from a recent post") });
    // Short sentences ("Short one.") and a different post don't count.
    expect(repeats("Short one. A different post about stake pools and their rewards this month.", recent)).toEqual({ repeated: false });
  });

  it("the writer gets the About text as background only, and the repeated sentences to avoid", async () => {
    const u = await user("pv-prompt@example.com", ["linkedin"]);
    const p = (await (await u.call("POST", "/passions", { name: "Cardano", about: "Cardano builder active since 2021" })).json()) as { id: string };
    const src = `src_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO source (id, org_id, kind, key, passion_id) VALUES (?, ?, 'rss', ?, ?)").bind(src, u.orgId, `https://example.com/${src}`, p.id).run();
    const ctx = `ctx_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO context_item (id, org_id, source_id, kind, title, body) VALUES (?, ?, ?, 'rss_item', 'Hydra update', 'Faster heads.')").bind(ctx, u.orgId, src).run();
    for (const t of ["Plutus got faster.", "Votes opened."]) {
      await env.DB.prepare("INSERT INTO draft (id, org_id, platform, text, status, issues) VALUES (?, ?, 'linkedin', ?, 'published', '[]')").bind(`drf_${crypto.randomUUID()}`, u.orgId, `${t}\n\n${BACKGROUND}`).run();
    }
    let prompt = "";
    const writer = fakeProvider((r) => {
      prompt = r.user;
      return JSON.stringify({ angle: "a", key_points: ["k"], variants: [{ platform: "linkedin", text: `Hydra heads got faster.\n\n${BACKGROUND}` }] });
    });
    const out = await compose(createDb(env.DB), [writer], { orgId: u.orgId, contextItemId: ctx, mode: "teach", platforms: ["linkedin"] });
    expect(prompt).toContain("for tone and knowledge only");
    expect(prompt).toContain("Don't restate it");
    expect(prompt).toContain("Sentences recent posts already used more than once");
    expect(prompt).toContain("- I've been in this ecosystem since 2021.");
    // If the writer still repeats it, the post is flagged (and automation won't approve it).
    expect(out.drafts[0]!.issues.find((i) => i.code === "too_similar")?.message).toContain("repeats a sentence");
  });
});

describe("crafted input stays fast (CodeQL, 2026-10-21)", () => {
  it("long runs of tabs or '#' never slow the clean-up", async () => {
    const tabs = `Post.${"\t".repeat(200_000)}x`;
    let t = Date.now();
    expect(placeLink("linkedin", withoutDisclosure(tabs, "I'm an ambassador"), "https://example.com/a")).toContain("Post.");
    expect(Date.now() - t).toBeLessThan(500);
    const u = await user("pv-hashes@example.com", ["x"]);
    const p = (await (await u.call("POST", "/passions", { name: "Hash" })).json()) as { id: string };
    t = Date.now();
    const res = await u.call("PATCH", `/passions/${p.id}`, { xHandle: `#${"#".repeat(70)}` });
    expect(res.status).toBe(200); // cut at the first "#": nothing left, so no handle, and quickly
    expect(Date.now() - t).toBeLessThan(2000);
    // Real handles still come out right.
    expect((await u.call("PATCH", `/passions/${p.id}`, { xHandle: "https://x.com/Cardano/status/1?s=20#top" })).status).toBe(200);
    expect(((await (await u.call("GET", "/passions")).json()) as { data: { xHandle: string }[] }).data[0]!.xHandle).toBe("Cardano");
  });
});

describe("official X accounts, quotes and mentions", () => {
  it("a passion keeps its official X account; the writer may mention it once on X only", async () => {
    const u = await user("pv-handle@example.com");
    const p = (await (await u.call("POST", "/passions", { name: "Cardano" })).json()) as { id: string };
    expect((await u.call("PATCH", `/passions/${p.id}`, { xHandle: "https://x.com/Cardano?s=20" })).status).toBe(200);
    const list = (await (await u.call("GET", "/passions")).json()) as { data: { xHandle: string }[] };
    expect(list.data[0]!.xHandle).toBe("Cardano");
    expect((await u.call("PATCH", `/passions/${p.id}`, { xHandle: "not a handle!" })).status).toBe(400);
    expect((await u.call("PATCH", `/passions/${p.id}`, { xHandle: "" })).status).toBe(200); // removed

    const base = { mode: "teach" as const, contextTitle: "t", contextBody: "b", stance: "other" as const, passion: { name: "Cardano", about: "", disclosure: "", relation: "follow" as const, xHandle: "Cardano" } };
    expect(composeUserPrompt({ ...base, platforms: ["x", "linkedin"] })).toContain("mention Cardano's official account @Cardano once");
    expect(composeUserPrompt({ ...base, platforms: ["linkedin"] })).not.toContain("@Cardano");
  });

  it("an idea from an X post: the X post ends with that post's link, which X shows as a quote", async () => {
    const u = await user("pv-quote@example.com", ["x"]);
    const p = (await (await u.call("POST", "/passions", { name: "Cardano" })).json()) as { id: string };
    const src = `src_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO source (id, org_id, kind, key, passion_id) VALUES (?, ?, 'x_account', 'iohk_charles', ?)").bind(src, u.orgId, p.id).run();
    const ctx = `ctx_${crypto.randomUUID()}`;
    const status = "https://x.com/iohk_charles/status/1002";
    await env.DB.prepare("INSERT INTO context_item (id, org_id, source_id, kind, title, body, url) VALUES (?, ?, ?, 'rss_item', 'Node 10.5 is out', 'Faster sync.', ?)").bind(ctx, u.orgId, src, status).run();
    const writer = fakeProvider(() => JSON.stringify({ angle: "a", key_points: ["k"], variants: [{ platform: "x", text: "Faster sync for every node operator." }] }));
    const out = await compose(createDb(env.DB), [writer], { orgId: u.orgId, contextItemId: ctx, mode: "teach", platforms: ["x"] });
    expect(out.drafts[0]!.text).toBe(`Faster sync for every node operator.\n\n${status}`);
    expect(out.drafts[0]!.parts).toBeNull();
  });

  it("X posts with a link, a quote or a mention never go through the API", async () => {
    expect(xNeedsTapToPost("x", "Great work by @Cardano on this.")).toBe(true);
    expect(xNeedsTapToPost("x", "@cardano shipped it")).toBe(true);
    expect(xNeedsTapToPost("x", "See https://x.com/a/status/1")).toBe(true);
    expect(xNeedsTapToPost("x", "Write to me at hello@example.com about it.")).toBe(false); // an email isn't a mention
    expect(xNeedsTapToPost("x", "A plain post.")).toBe(false);
    expect(xNeedsTapToPost("linkedin", "Thanks @Cardano")).toBe(false);

    const u = await user("pv-api@example.com", ["x"]);
    const deps: PublishDeps = { db: createDb(env.DB), key: await importTokenKey(env.TOKEN_ENCRYPTION_KEY), configs: { mastodonRedirectUri: `${BASE}/cb` } };
    const conn = await saveConnection(deps, { orgId: u.orgId, platform: "x", account: { accountId: "x-v", handle: "@v" }, secret: { tokens: { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600_000 } }, meta: {}, userId: u.userId });
    const id = `drf_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO draft (id, org_id, platform, text, status, issues, connection_id) VALUES (?, ?, 'x', 'Well done @Cardano.', 'approved', '[]', ?)").bind(id, u.orgId, conn).run();
    let contacted = false;
    const err = await publishDraft({ ...deps, fetch: (async () => ((contacted = true), new Response("{}"))) as typeof fetch }, { orgId: u.orgId, draftId: id }).catch((e: { code?: string; message?: string }) => e);
    expect(err).toMatchObject({ code: "needs_tap_to_post", message: expect.stringContaining("a mention") });
    expect(contacted).toBe(false);
    expect((await u.call("POST", `/drafts/${id}/schedule`, { connectionId: conn, at: new Date(Date.now() + 86_400_000).toISOString() })).status).toBe(409);
  });
});
