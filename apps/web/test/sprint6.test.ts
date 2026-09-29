import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb } from "@nextrium/db";
import {
  autoImagesForBrief,
  detectImageType,
  findImage,
  findLinkImage,
  imageSize,
  importTokenKey,
  publishDraft,
  saveConnection,
  type ImageDeps,
  type PublishDeps,
} from "@nextrium/core";

const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.18.${Math.floor(++n / 250)}.${n % 250}`;
const media = () => (env as unknown as { MEDIA: R2Bucket }).MEDIA;

/** A tiny but valid-looking PNG header with the given size (enough for type and size detection). */
function png(width: number, height: number, pad = 64) {
  const b = new Uint8Array(24 + pad);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}
/** A JPEG header with a SOF0 frame giving its size. */
function jpeg(width: number, height: number) {
  const b = new Uint8Array(64);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255]);
  return b;
}

async function user(email: string, platforms = ["bluesky", "linkedin", "tiktok"]) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() },
    body: JSON.stringify({ email, name: "S6", password: "correct-horse-battery" }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = (method: string, path: string, body?: unknown) =>
    SELF.fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const put = (draftId: string, bytes: Uint8Array<ArrayBuffer>, source = "upload", alt = "") => {
    const form = new FormData();
    form.set("file", new File([bytes], "i.png", { type: "image/png" }));
    form.set("source", source);
    form.set("alt", alt);
    return SELF.fetch(`${BASE}/api/v1/drafts/${draftId}/image`, { method: "PUT", headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip() }, body: form });
  };
  await call("PUT", "/persona", { displayName: "S", platforms });
  const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string } };
  const row = await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>();
  return { call, put, cookie, orgId: me.workspace.id, userId: row!.id };
}
type U = Awaited<ReturnType<typeof user>>;
async function post(u: U, platforms = ["bluesky"]) {
  const ctx = (await (await u.call("POST", "/contexts", { kind: "manual", body: "We shipped retries with backoff today." })).json()) as { id: string };
  return ((await (await u.call("POST", "/compose", { contextItemId: ctx.id, mode: "teach", platforms })).json()) as { briefId: string; drafts: { id: string; platform: string }[] });
}

describe("image files", () => {
  it("detect type and size from the bytes", () => {
    expect(detectImageType(png(1200, 675))).toBe("image/png");
    expect(imageSize(png(1200, 675))).toEqual({ width: 1200, height: 675 });
    expect(imageSize(jpeg(1080, 1350))).toEqual({ width: 1080, height: 1350 });
    expect(detectImageType(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });
});

describe("serving and changing a post's image", () => {
  it("stores, serves safely, and only to the workspace", async () => {
    const u = await user("s6-serve@example.com");
    const other = await user("s6-other@example.com");
    const { drafts } = await post(u);
    const id = drafts[0]!.id;
    expect((await u.put(id, png(1200, 675), "upload", "Our team at the launch")).status).toBe(200);
    const res = await u.call("GET", `/drafts/${id}/image`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect((await other.call("GET", `/drafts/${id}/image`)).status).toBe(404);
    expect((await other.put(id, png(10, 10))).status).toBe(404);
    const listed = (await (await u.call("GET", `/drafts/${id}`)).json()) as { draft: { image: Record<string, unknown> } };
    expect(listed.draft.image).toMatchObject({ source: "upload", alt: "Our team at the launch", width: 1200, height: 675, aiGenerated: false });
    expect(listed.draft.image).not.toHaveProperty("key");
  });

  it("refuses files that aren't images, and oversized ones", async () => {
    const u = await user("s6-refuse@example.com");
    const { drafts } = await post(u);
    expect((await u.put(drafts[0]!.id, new TextEncoder().encode("<svg onload=alert(1)></svg>"))).status).toBe(415);
    const big = new Uint8Array(5 * 1024 * 1024 + 10);
    big.set(png(10, 10));
    expect((await u.put(drafts[0]!.id, big)).status).toBe(413);
  });

  it("edits the description, removes the file from storage, and freezes published posts", async () => {
    const u = await user("s6-edit@example.com");
    const { drafts } = await post(u);
    const id = drafts[0]!.id;
    await u.put(id, png(1080, 1080));
    expect(((await (await u.call("PATCH", `/drafts/${id}/image`, { alt: "A whiteboard" })).json()) as { image: { alt: string } }).image.alt).toBe("A whiteboard");
    const key = (await env.DB.prepare("SELECT json_extract(image, '$.key') AS k FROM draft WHERE id = ?").bind(id).first<{ k: string }>())!.k;
    expect(await media().get(key)).not.toBeNull();
    expect((await u.call("DELETE", `/drafts/${id}/image`)).status).toBe(204);
    expect(await media().get(key)).toBeNull();
    await u.put(id, png(1080, 1080));
    await env.DB.prepare("UPDATE draft SET status = 'published' WHERE id = ?").bind(id).run();
    expect((await u.put(id, png(1080, 1080))).status).toBe(409);
    expect((await u.call("DELETE", `/drafts/${id}/image`)).status).toBe(409);
  });

  it("signed links work without signing in, briefly, and stop when the image changes", async () => {
    const u = await user("s6-link@example.com");
    const { drafts } = await post(u);
    const id = drafts[0]!.id;
    await u.put(id, png(1200, 675));
    const { url } = (await (await u.call("POST", `/drafts/${id}/image/link`)).json()) as { url: string };
    expect((await SELF.fetch(`${BASE}${url}`)).status).toBe(200);
    expect((await SELF.fetch(`${BASE}${url.replace(/sig=.{4}/, "sig=AAAA")}`)).status).toBe(403);
    expect((await SELF.fetch(`${BASE}${url.replace(/exp=\d+/, `exp=${Date.now() - 1000}`)}`)).status).toBe(403);
    expect((await SELF.fetch(`${BASE}${url.replace(/exp=\d+/, `exp=${Date.now() + 86_400_000}`)}`)).status).toBe(403); // too far ahead
    await u.put(id, png(1080, 1080)); // replaced
    expect((await SELF.fetch(`${BASE}${url}`)).status).toBe(403);
  });
});

describe("finding an image", () => {
  const page = (og: string) => new Response(`<html><head><meta property="og:image" content="${og}"><meta property="og:image:alt" content="Release notes chart"></head></html>`, { headers: { "Content-Type": "text/html" } });

  it("uses the link's own preview image, and ignores icons and internal addresses", async () => {
    const fetchOk = async (url: string) => (url === "https://ex.org/post" ? page("/og.png") : url === "https://ex.org/og.png" ? new Response(png(1200, 630), { headers: { "Content-Type": "image/png" } }) : new Response("", { status: 404 }));
    expect(await findLinkImage("https://ex.org/post", fetchOk)).toMatchObject({ url: "https://ex.org/og.png", alt: "Release notes chart" });
    const icon = async (url: string) => (url === "https://ex.org/post" ? page("/icon.png") : new Response(png(32, 32), { headers: { "Content-Type": "image/png" } }));
    expect(await findLinkImage("https://ex.org/post", icon)).toBeNull();
    const internal = async (url: string) => (url === "https://ex.org/post" ? page("http://169.254.169.254/latest/meta-data") : new Response(png(1200, 630), { headers: { "Content-Type": "image/png" } }));
    await expect(findLinkImage("https://ex.org/post", internal)).rejects.toThrow();
  });

  it("falls back to AI only when allowed, and caps AI images per day", async () => {
    const u = await user("s6-ai@example.com");
    let aiCalls = 0;
    const deps: ImageDeps = {
      db: createDb(env.DB),
      store: media(),
      ai: { run: async () => ((aiCalls++, { image: btoa(String.fromCharCode(...jpeg(1024, 1024))) })) },
    };
    const ctx = { kind: "manual", title: "A note", url: null, mediaKey: null };
    expect(await findImage(deps, u.orgId, ctx, "Retries got safer.", { allowAi: false })).toBeNull();
    expect(aiCalls).toBe(0);
    const found = await findImage(deps, u.orgId, ctx, "Retries got safer.", { allowAi: true });
    expect(found).toMatchObject({ source: "ai" });
    expect(found!.alt).toMatch(/^AI-generated illustration/);
    // Free plan: 3 AI images a day (counted per set of posts).
    for (let i = 0; i < 3; i++) {
      const { briefId } = await post(u);
      await autoImagesForBrief(deps, u.orgId, briefId);
    }
    await expect(findImage(deps, u.orgId, ctx, "Another.", { allowAi: true, only: "ai" })).rejects.toThrow(/today's 3 AI images/);
  });

  it("attaches the person's own photo to every post that should have an image", async () => {
    const u = await user("s6-auto@example.com");
    const photo = png(1600, 1200);
    const form = new FormData();
    form.set("file", new File([photo], "team.png", { type: "image/png" }));
    form.set("caption", "Our team at the hackathon");
    const up = (await (await SELF.fetch(`${BASE}/api/v1/contexts/upload`, { method: "POST", headers: { Cookie: u.cookie, Origin: BASE, "CF-Connecting-IP": ip() }, body: form })).json()) as { id: string };
    const out = (await (await u.call("POST", "/compose", { contextItemId: up.id, mode: "smile", platforms: ["bluesky", "linkedin", "tiktok"] })).json()) as { briefId: string };
    const res = await autoImagesForBrief({ db: createDb(env.DB), store: media() }, u.orgId, out.briefId);
    expect(res).toMatchObject({ attached: 2, source: "upload" }); // TikTok is video: no image
    const rows = await env.DB.prepare("SELECT platform, json_extract(image, '$.source') AS s, json_extract(image, '$.alt') AS alt FROM draft WHERE brief_id = ? ORDER BY platform").bind(out.briefId).all<{ platform: string; s: string | null; alt: string | null }>();
    expect(rows.results).toEqual([
      { platform: "bluesky", s: "upload", alt: "Our team at the hackathon" },
      { platform: "linkedin", s: "upload", alt: "Our team at the hackathon" },
      { platform: "tiktok", s: null, alt: null },
    ]);
  });
});

describe("publishing with an image", () => {
  async function ready(email: string, platform: "bluesky" | "x") {
    const u = await user(email, [platform]);
    const { drafts } = await post(u, [platform]);
    const id = drafts[0]!.id;
    await u.call("PATCH", `/drafts/${id}`, { status: "approved" });
    return { u, id };
  }
  function net(opts: { imageStatus?: number } = {}) {
    const sent: { url: string; body: unknown }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      if (url.endsWith("createSession")) return Response.json({ accessJwt: "jwt", did: "did:plc:s6", handle: "s6.bsky.social" });
      if (url.endsWith("uploadBlob") || url.endsWith("/2/media/upload")) {
        sent.push({ url, body: null });
        if (opts.imageStatus) return new Response("{}", { status: opts.imageStatus });
        return url.endsWith("uploadBlob") ? Response.json({ blob: { $type: "blob", ref: { $link: "bafy" }, mimeType: "image/png", size: 88 } }) : Response.json({ data: { id: "m1" } });
      }
      if (url.endsWith("/2/media/metadata")) return Response.json({});
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      sent.push({ url, body });
      if (url.endsWith("createRecord")) return Response.json({ uri: "at://did:plc:s6/app.bsky.feed.post/1", cid: "c1" });
      if (url.endsWith("/2/tweets")) return Response.json({ data: { id: "t1" } });
      return new Response("{}", { status: 404 });
    };
    return { sent, fetch };
  }
  const depsFor = async (f: ReturnType<typeof net>): Promise<PublishDeps> => ({ db: createDb(env.DB), key: await importTokenKey(env.TOKEN_ENCRYPTION_KEY), configs: { mastodonRedirectUri: `${BASE}/cb` }, fetch: f.fetch, media: media() });

  it("Bluesky: uploads the image and embeds it with its description", async () => {
    const { u, id } = await ready("s6-pub-bsky@example.com", "bluesky");
    await u.put(id, png(1200, 675), "upload", "A chart of error rates");
    const f = net();
    const d = await depsFor(f);
    const conn = await saveConnection(d, { orgId: u.orgId, platform: "bluesky", account: { accountId: "did:plc:s6", handle: "@s6" }, secret: { identifier: "s6", appPassword: "aaaa-bbbb-cccc-dddd" }, meta: {}, userId: u.userId });
    await env.DB.prepare("UPDATE draft SET connection_id = ? WHERE id = ?").bind(conn, id).run();
    await publishDraft(d, { orgId: u.orgId, draftId: id });
    const record = (f.sent.find((s) => s.url.endsWith("createRecord"))!.body as { record: { embed: { images: { alt: string; aspectRatio: unknown }[] } } }).record;
    expect(record.embed.images[0]).toMatchObject({ alt: "A chart of error rates", aspectRatio: { width: 1200, height: 675 } });
  });

  it("X: if the image is refused, the post still goes out, says why, and the account isn't marked broken", async () => {
    const { u, id } = await ready("s6-pub-x@example.com", "x");
    await u.put(id, png(1200, 675), "upload", "Chart");
    const f = net({ imageStatus: 403 }); // an account connected before images needed media.write
    const d = await depsFor(f);
    const conn = await saveConnection(d, { orgId: u.orgId, platform: "x", account: { accountId: "99", handle: "@s6" }, secret: { tokens: { accessToken: "tok" } }, meta: {}, userId: u.userId });
    await env.DB.prepare("UPDATE draft SET connection_id = ? WHERE id = ?").bind(conn, id).run();
    await env.DB.prepare("UPDATE org SET plan = 'pro' WHERE id = ?").bind(u.orgId).run(); // X allowance, no credits needed
    await publishDraft(d, { orgId: u.orgId, draftId: id });
    const row = await env.DB.prepare("SELECT status, last_error FROM draft WHERE id = ?").bind(id).first<{ status: string; last_error: string }>();
    expect(row!.status).toBe("published");
    expect(row!.last_error).toMatch(/^Posted without the image: X didn't accept the image\. Reconnect/);
    expect((f.sent.find((s) => s.url.endsWith("/2/tweets"))!.body as Record<string, unknown>).media).toBeUndefined();
    expect((await env.DB.prepare("SELECT status FROM connection WHERE id = ?").bind(conn).first<{ status: string }>())!.status).toBe("active");
  });
});
