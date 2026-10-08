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
import { linkedin } from "@nextrium/platforms";

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
/** A WebP header (RIFF....WEBP). */
function webp() {
  const b = new Uint8Array(64);
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  return b;
}

type Img = { id: string; position: number; alt: string; shared: boolean; source: string; original: { width?: number; height?: number }; variants: Record<string, { width?: number; height?: number }> };

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
  const form = (bytes: Uint8Array<ArrayBuffer>, fields: Record<string, string> = {}) => {
    const f = new FormData();
    f.set("file", new File([bytes], "i.png", { type: "image/png" }));
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };
  const send = (method: string, path: string, body: FormData) => SELF.fetch(`${BASE}/api/v1${path}`, { method, headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip() }, body });
  /** Adds an image to the post's set. */
  const add = (draftId: string, bytes: Uint8Array<ArrayBuffer>, source = "upload", alt = "") => send("POST", `/drafts/${draftId}/images`, form(bytes, { source, alt }));
  const added = async (draftId: string, bytes: Uint8Array<ArrayBuffer>, alt = "") => ((await (await add(draftId, bytes, "upload", alt)).json()) as { image: Img }).image;
  const crop = (imageId: string, size: string, bytes: Uint8Array<ArrayBuffer>) => send("PUT", `/images/${imageId}/variants/${size}`, form(bytes));
  const set = async (draftId: string) => (await (await call("GET", `/drafts/${draftId}/images`)).json()) as { own: boolean; sharedWith: number; images: Img[] };
  await call("PUT", "/persona", { displayName: "S", platforms });
  const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string } };
  const row = await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>();
  return { call, add, added, crop, set, cookie, orgId: me.workspace.id, userId: row!.id };
}
type U = Awaited<ReturnType<typeof user>>;
async function post(u: U, platforms = ["bluesky"]) {
  const ctx = (await (await u.call("POST", "/contexts", { kind: "manual", body: "We shipped retries with backoff today." })).json()) as { id: string };
  return (await (await u.call("POST", "/compose", { contextItemId: ctx.id, mode: "teach", platforms })).json()) as { briefId: string; drafts: { id: string; platform: string }[] };
}

describe("image files", () => {
  it("detect type and size from the bytes", () => {
    expect(detectImageType(png(1200, 675))).toBe("image/png");
    expect(imageSize(png(1200, 675))).toEqual({ width: 1200, height: 675 });
    expect(imageSize(jpeg(1080, 1350))).toEqual({ width: 1080, height: 1350 });
    expect(detectImageType(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });
});

describe("a post's images", () => {
  it("stores, serves safely, and only to the workspace", async () => {
    const u = await user("s6-serve@example.com");
    const other = await user("s6-other@example.com");
    const { drafts } = await post(u);
    const id = drafts[0]!.id;
    const add = await u.add(id, png(1200, 675), "upload", "Our team at the launch");
    expect(add.status).toBe(201);
    const img = ((await add.json()) as { image: Img }).image;
    const res = await u.call("GET", `/images/${img.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect((await other.call("GET", `/images/${img.id}`)).status).toBe(404);
    expect((await other.add(id, png(10, 10))).status).toBe(404);
    expect((await other.call("GET", `/drafts/${id}/images`)).status).toBe(404);
    const listed = (await (await u.call("GET", `/drafts/${id}`)).json()) as { draft: { images: Img[]; ownImages: boolean } };
    expect(listed.draft.images).toHaveLength(1);
    expect(listed.draft.images[0]).toMatchObject({ source: "upload", alt: "Our team at the launch", original: { width: 1200, height: 675 }, aiGenerated: false, shared: true });
    expect(JSON.stringify(listed.draft)).not.toContain("orgs/"); // storage keys never leave the server
  });

  it("refuses files that aren't images, oversized ones, and a fifth image", async () => {
    const u = await user("s6-refuse@example.com");
    const { drafts } = await post(u);
    const id = drafts[0]!.id;
    expect((await u.add(id, new TextEncoder().encode("<svg onload=alert(1)></svg>"))).status).toBe(415);
    const big = new Uint8Array(5 * 1024 * 1024 + 10);
    big.set(png(10, 10));
    expect((await u.add(id, big)).status).toBe(413);
    for (let i = 0; i < 4; i++) expect((await u.add(id, png(1200, 675))).status).toBe(201);
    expect((await u.add(id, png(1200, 675))).status).toBe(429);
    expect((await u.set(id)).images.map((i) => i.position)).toEqual([0, 1, 2, 3]);
  });

  it("is shared by every post from the same material, unless a post takes its own", async () => {
    const u = await user("s6-share@example.com");
    const { drafts } = await post(u, ["bluesky", "linkedin"]);
    const [a, b] = [drafts.find((d) => d.platform === "bluesky")!.id, drafts.find((d) => d.platform === "linkedin")!.id];
    await u.added(a, png(1200, 675), "One");
    await u.added(b, png(1080, 1080), "Two"); // added from the other post: same set
    expect((await u.set(a)).images.map((i) => i.alt)).toEqual(["One", "Two"]);
    expect(await u.set(b)).toMatchObject({ own: false, sharedWith: 1 });

    // B takes its own copy, then changes it: A is untouched.
    const own = (await (await u.call("POST", `/drafts/${b}/images/own`, { own: true })).json()) as { own: boolean; images: Img[] };
    expect(own.own).toBe(true);
    expect(own.images.map((i) => [i.alt, i.shared])).toEqual([["One", false], ["Two", false]]);
    await u.call("DELETE", `/images/${own.images[0]!.id}`);
    expect((await u.set(b)).images.map((i) => i.alt)).toEqual(["Two"]);
    expect((await u.set(a)).images.map((i) => i.alt)).toEqual(["One", "Two"]);
    expect((await u.set(a)).sharedWith).toBe(0);

    // Back to sharing: B's own images and their files are gone.
    const ownKeys = (await env.DB.prepare("SELECT json_extract(original, '$.key') AS k FROM post_image WHERE draft_id = ?").bind(b).all<{ k: string }>()).results.map((r) => r.k);
    expect(ownKeys).toHaveLength(1);
    expect(((await (await u.call("POST", `/drafts/${b}/images/own`, { own: false })).json()) as { images: Img[] }).images.map((i) => i.alt)).toEqual(["One", "Two"]);
    expect(await media().get(ownKeys[0]!)).toBeNull();
  });

  it("reorders, edits the description, deletes files from storage, and freezes published posts", async () => {
    const u = await user("s6-edit@example.com");
    const { drafts } = await post(u);
    const id = drafts[0]!.id;
    const first = await u.added(id, png(1080, 1080), "first");
    const second = await u.added(id, png(1080, 1080), "second");
    await u.call("PATCH", `/images/${second.id}`, { position: 0 });
    expect((await u.set(id)).images.map((i) => i.alt)).toEqual(["second", "first"]);
    expect(((await (await u.call("PATCH", `/images/${first.id}`, { alt: "A whiteboard" })).json()) as { image: Img }).image.alt).toBe("A whiteboard");
    const key = (await env.DB.prepare("SELECT json_extract(original, '$.key') AS k FROM post_image WHERE id = ?").bind(first.id).first<{ k: string }>())!.k;
    expect(await media().get(key)).not.toBeNull();
    expect((await u.call("DELETE", `/images/${first.id}`)).status).toBe(204);
    expect(await media().get(key)).toBeNull();
    expect((await u.set(id)).images.map((i) => i.position)).toEqual([0]);
    // A post's own images are frozen once it's published.
    await u.call("POST", `/drafts/${id}/images/own`, { own: true });
    const mine = (await u.set(id)).images[0]!;
    await env.DB.prepare("UPDATE draft SET status = 'published' WHERE id = ?").bind(id).run();
    expect((await u.add(id, png(1080, 1080))).status).toBe(409);
    expect((await u.call("DELETE", `/images/${mine.id}`)).status).toBe(409);
    expect((await u.crop(mine.id, "landscape", png(1200, 675))).status).toBe(409);
    expect((await u.call("POST", `/drafts/${id}/images/own`, { own: false })).status).toBe(409);
  });

  it("keeps the original when cropping, serves each shape, and can go back", async () => {
    const u = await user("s6-crop@example.com");
    const { drafts } = await post(u);
    const img = await u.added(drafts[0]!.id, png(4000, 3000), "Photo");
    const cropped = await u.crop(img.id, "landscape", png(4000, 2250));
    expect(cropped.status).toBe(200);
    expect(((await cropped.json()) as { image: Img }).image).toMatchObject({ original: { width: 4000, height: 3000 }, variants: { landscape: { width: 4000, height: 2250 } } });
    expect((await u.crop(img.id, "wide", png(10, 10))).status).toBe(400);
    const served = async (size: string) => imageSize(new Uint8Array(await (await u.call("GET", `/images/${img.id}?size=${size}`)).arrayBuffer()));
    expect(await served("landscape")).toEqual({ width: 4000, height: 2250 });
    expect(await served("original")).toEqual({ width: 4000, height: 3000 });
    expect(await served("square")).toEqual({ width: 4000, height: 3000 }); // no square crop: the original
    // A new crop replaces the old file.
    const oldKey = (await env.DB.prepare("SELECT json_extract(variants, '$.landscape.key') AS k FROM post_image WHERE id = ?").bind(img.id).first<{ k: string }>())!.k;
    await u.crop(img.id, "landscape", png(3800, 2138));
    expect(await media().get(oldKey)).toBeNull();
    const back = (await (await u.call("DELETE", `/images/${img.id}/variants/landscape`)).json()) as { image: Img };
    expect(back.image.variants).toEqual({});
  });

  it("lists many posts with their images (more than one query's worth of ids)", async () => {
    const u = await user("s6-many@example.com");
    const { drafts, briefId } = await post(u);
    await u.added(drafts[0]!.id, png(1200, 675), "Shared");
    // 150 more posts: 120 with their own (empty) set (over D1's 100 variables), 30 sharing the material's.
    const stmts = Array.from({ length: 150 }, (_, i) =>
      env.DB.prepare("INSERT INTO draft (id, org_id, brief_id, platform, text, status, issues, own_images) VALUES (?, ?, ?, 'bluesky', 'x', 'draft', '[]', ?)").bind(`drf_many_${i}`, u.orgId, briefId, i < 120 ? 1 : 0),
    );
    await env.DB.batch(stmts);
    const res = await u.call("GET", "/drafts");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string; images: Img[]; ownImages: boolean }[] };
    expect(data.length).toBeGreaterThan(150);
    expect(data.filter((d) => !d.ownImages).every((d) => d.images.length === 1 && d.images[0]!.alt === "Shared")).toBe(true);
    expect(data.filter((d) => d.ownImages).every((d) => d.images.length === 0)).toBe(true);
  });

  it("signed links work without signing in, briefly, and stop when the file changes", async () => {
    const u = await user("s6-link@example.com");
    const { drafts } = await post(u);
    const img = await u.added(drafts[0]!.id, png(1200, 900));
    await u.crop(img.id, "landscape", png(1200, 675));
    const { url } = (await (await u.call("POST", `/images/${img.id}/link?size=landscape`)).json()) as { url: string };
    const ok = await SELF.fetch(`${BASE}${url}`);
    expect(ok.status).toBe(200);
    expect(imageSize(new Uint8Array(await ok.arrayBuffer()))).toEqual({ width: 1200, height: 675 });
    expect((await SELF.fetch(`${BASE}${url.replace(/sig=.{4}/, "sig=AAAA")}`)).status).toBe(403);
    expect((await SELF.fetch(`${BASE}${url.replace("size=landscape", "size=original")}`)).status).toBe(403); // the size is signed
    expect((await SELF.fetch(`${BASE}${url.replace(/exp=\d+/, `exp=${Date.now() - 1000}`)}`)).status).toBe(403);
    expect((await SELF.fetch(`${BASE}${url.replace(/exp=\d+/, `exp=${Date.now() + 86_400_000}`)}`)).status).toBe(403); // too far ahead
    await u.crop(img.id, "landscape", png(1100, 619)); // replaced
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
    // Free plan: 3 AI images a day (one per set of posts).
    for (let i = 0; i < 3; i++) {
      const { briefId } = await post(u);
      await autoImagesForBrief(deps, u.orgId, briefId);
    }
    await expect(findImage(deps, u.orgId, ctx, "Another.", { allowAi: true, only: "ai" })).rejects.toThrow(/today's 3 AI images/);
  });

  it("adds the person's own photo once, shared by every post that shows images", async () => {
    const u = await user("s6-auto@example.com");
    const form = new FormData();
    form.set("file", new File([png(1600, 1200)], "team.png", { type: "image/png" }));
    form.set("caption", "Our team at the hackathon");
    const up = (await (await SELF.fetch(`${BASE}/api/v1/contexts/upload`, { method: "POST", headers: { Cookie: u.cookie, Origin: BASE, "CF-Connecting-IP": ip() }, body: form })).json()) as { id: string };
    const out = (await (await u.call("POST", "/compose", { contextItemId: up.id, mode: "smile", platforms: ["bluesky", "linkedin", "tiktok"] })).json()) as { briefId: string; drafts: { id: string; platform: string }[] };
    // Composing already started this in the background; running it again, even at the same time, adds no second image.
    const deps = { db: createDb(env.DB), store: media() };
    await Promise.all([autoImagesForBrief(deps, u.orgId, out.briefId), autoImagesForBrief(deps, u.orgId, out.briefId)]);
    expect(await autoImagesForBrief(deps, u.orgId, out.briefId)).toMatchObject({ attached: 0 });
    for (const d of out.drafts.filter((x) => x.platform !== "tiktok")) {
      expect((await u.set(d.id)).images.map((i) => [i.source, i.alt])).toEqual([["upload", "Our team at the hackathon"]]);
    }
  });
});

describe("publishing with images", () => {
  async function ready(email: string, platform: "bluesky" | "x" | "linkedin") {
    const u = await user(email, [platform]);
    const { drafts } = await post(u, [platform]);
    const id = drafts[0]!.id;
    await u.call("PATCH", `/drafts/${id}`, { status: "approved" });
    return { u, id };
  }
  function net(opts: { imageStatus?: number; linkedinStatus?: string } = {}) {
    const sent: { url: string; method: string; body: unknown }[] = [];
    let urn = 0;
    const fetch = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("createSession")) return Response.json({ accessJwt: "jwt", did: "did:plc:s6", handle: "s6.bsky.social" });
      if (url.endsWith("uploadBlob") || url.endsWith("/2/media/upload")) {
        sent.push({ url, method, body: null });
        if (opts.imageStatus) return new Response("{}", { status: opts.imageStatus });
        return url.endsWith("uploadBlob") ? Response.json({ blob: { $type: "blob", ref: { $link: `bafy${sent.length}` }, mimeType: "image/png", size: 88 } }) : Response.json({ data: { id: `m${sent.length}` } });
      }
      if (url.endsWith("/2/media/metadata")) return Response.json({});
      if (url.includes("action=initializeUpload")) {
        sent.push({ url, method, body: null });
        return Response.json({ value: { uploadUrl: "https://www.linkedin.com/dms-uploads/x", image: `urn:li:image:I${++urn}` } });
      }
      if (url.startsWith("https://www.linkedin.com/dms-uploads/")) return new Response(null, { status: 201 });
      if (url.includes("/rest/images/urn")) {
        sent.push({ url, method, body: null });
        return Response.json({ status: opts.linkedinStatus ?? "AVAILABLE" });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      sent.push({ url, method, body });
      if (url.endsWith("createRecord")) return Response.json({ uri: "at://did:plc:s6/app.bsky.feed.post/1", cid: "c1" });
      if (url.endsWith("/2/tweets")) return Response.json({ data: { id: "t1" } });
      if (url.endsWith("/rest/posts")) return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:1" } });
      return new Response("{}", { status: 404 });
    };
    return { sent, fetch };
  }
  const depsFor = async (f: ReturnType<typeof net>): Promise<PublishDeps> => ({ db: createDb(env.DB), key: await importTokenKey(env.TOKEN_ENCRYPTION_KEY), configs: { mastodonRedirectUri: `${BASE}/cb` }, fetch: f.fetch, media: media() });

  it("Bluesky: uploads every image, in order, with descriptions and the chosen shape", async () => {
    const { u, id } = await ready("s6-pub-bsky@example.com", "bluesky");
    const one = await u.added(id, png(1600, 1200), "A chart of error rates");
    await u.crop(one.id, "landscape", png(1600, 900));
    await u.added(id, png(1080, 1080), "The team");
    const f = net();
    const d = await depsFor(f);
    const conn = await saveConnection(d, { orgId: u.orgId, platform: "bluesky", account: { accountId: "did:plc:s6", handle: "@s6" }, secret: { identifier: "s6", appPassword: "aaaa-bbbb-cccc-dddd" }, meta: {}, userId: u.userId });
    await env.DB.prepare("UPDATE draft SET connection_id = ? WHERE id = ?").bind(conn, id).run();
    await publishDraft(d, { orgId: u.orgId, draftId: id });
    const record = (f.sent.find((s) => s.url.endsWith("createRecord"))!.body as { record: { embed: { images: { alt: string; aspectRatio: unknown }[] } } }).record;
    expect(record.embed.images).toMatchObject([
      { alt: "A chart of error rates", aspectRatio: { width: 1600, height: 900 } }, // the landscape crop (Bluesky's default shape)
      { alt: "The team", aspectRatio: { width: 1080, height: 1080 } },
    ]);
  });

  it("LinkedIn: waits until each image is ready, then posts them together", async () => {
    const { u, id } = await ready("s6-pub-li@example.com", "linkedin");
    await u.added(id, png(1200, 675), "First");
    await u.added(id, png(1200, 675), "Second");
    const f = net();
    const d = await depsFor(f);
    const conn = await saveConnection(d, { orgId: u.orgId, platform: "linkedin", account: { accountId: "abc", handle: "S" }, secret: { tokens: { accessToken: "tok" } }, meta: {}, userId: u.userId });
    await env.DB.prepare("UPDATE draft SET connection_id = ? WHERE id = ?").bind(conn, id).run();
    await publishDraft(d, { orgId: u.orgId, draftId: id });
    const order = f.sent.map((s) => (s.url.includes("initializeUpload") ? "upload" : s.url.includes("/rest/images/urn") ? "check" : s.url.endsWith("/rest/posts") ? "post" : "other"));
    expect(order).toEqual(["upload", "check", "upload", "check", "post"]);
    const body = f.sent.find((s) => s.url.endsWith("/rest/posts"))!.body as { content: { multiImage: { images: { id: string; altText: string }[] } } };
    expect(body.content.multiImage.images).toEqual([{ id: "urn:li:image:I1", altText: "First" }, { id: "urn:li:image:I2", altText: "Second" }]);
    expect((await env.DB.prepare("SELECT status, last_error FROM draft WHERE id = ?").bind(id).first())).toMatchObject({ status: "published", last_error: null });
  });

  it("LinkedIn: leaves out WebP (LinkedIn doesn't take it) and says so", async () => {
    const { u, id } = await ready("s6-pub-li-webp@example.com", "linkedin");
    await u.add(id, webp());
    const f = net();
    const d = await depsFor(f);
    const conn = await saveConnection(d, { orgId: u.orgId, platform: "linkedin", account: { accountId: "abc", handle: "S" }, secret: { tokens: { accessToken: "tok" } }, meta: {}, userId: u.userId });
    await env.DB.prepare("UPDATE draft SET connection_id = ? WHERE id = ?").bind(conn, id).run();
    await publishDraft(d, { orgId: u.orgId, draftId: id });
    expect(f.sent.some((s) => s.url.includes("initializeUpload"))).toBe(false);
    const row = await env.DB.prepare("SELECT status, last_error FROM draft WHERE id = ?").bind(id).first<{ status: string; last_error: string }>();
    expect(row!.status).toBe("published");
    expect(row!.last_error).toMatch(/not every image went with it\. Image 1: LinkedIn takes JPG, PNG or GIF only/);
  });

  it("LinkedIn's readiness check: done when available, an error when processing failed, a short wait when it can't be read", async () => {
    const tokens = { accessToken: "tok" };
    const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
    await expect(linkedin.waitUntilReady(tokens, "urn:li:image:1", reply(200, { status: "AVAILABLE" }), [0])).resolves.toBeUndefined();
    await expect(linkedin.waitUntilReady(tokens, "urn:li:image:1", reply(200, { status: "PROCESSING_FAILED" }), [0])).rejects.toThrow(/couldn't process/);
    let calls = 0;
    const forbidden = async () => ((calls++, new Response("{}", { status: 403 })));
    await linkedin.waitUntilReady(tokens, "urn:li:image:1", forbidden, [0, 0, 0]);
    expect(calls).toBe(2); // both addresses tried once, then it stops asking
  });

  it("X: if images are refused, the post still goes out, says why, and the account isn't marked broken", async () => {
    const { u, id } = await ready("s6-pub-x@example.com", "x");
    await u.added(id, png(1200, 675), "Chart");
    const f = net({ imageStatus: 403 }); // an account connected before images needed media.write
    const d = await depsFor(f);
    const conn = await saveConnection(d, { orgId: u.orgId, platform: "x", account: { accountId: "99", handle: "@s6" }, secret: { tokens: { accessToken: "tok" } }, meta: {}, userId: u.userId });
    await env.DB.prepare("UPDATE draft SET connection_id = ? WHERE id = ?").bind(conn, id).run();
    await env.DB.prepare("UPDATE org SET plan = 'pro' WHERE id = ?").bind(u.orgId).run(); // X allowance, no credits needed
    await publishDraft(d, { orgId: u.orgId, draftId: id });
    const row = await env.DB.prepare("SELECT status, last_error FROM draft WHERE id = ?").bind(id).first<{ status: string; last_error: string }>();
    expect(row!.status).toBe("published");
    expect(row!.last_error).toMatch(/^Posted, but not every image went with it\. Image 1: X didn't accept it\. Reconnect/);
    expect((f.sent.find((s) => s.url.endsWith("/2/tweets"))!.body as Record<string, unknown>).media).toBeUndefined();
    expect((await env.DB.prepare("SELECT status FROM connection WHERE id = ?").bind(conn).first<{ status: string }>())!.status).toBe("active");
  });
});
