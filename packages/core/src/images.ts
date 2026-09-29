// Sprint 6: one image per post. Sources, in order: the person's own photo → the link's own preview
// image → a screenshot of the page (when Browser Rendering is set up) → an AI image (when allowed,
// always labelled). Designed cards and crops to the preferred size are made in the browser and
// uploaded like a photo. Images are private in R2 and served only through the app.
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { brief, contextItem, draft, imageSetting, type Db, type ImageSize, type ImageSource, type Platform, type PostImage } from "@nextrium/db";
import { getOrgPlan } from "./content.js";
import { newId } from "./ids.js";
import { PLAN_LIMITS } from "./plans.js";
import { assertSafeUrl, safeFetchBytes, safeFetchText } from "./safe-fetch.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Sensible defaults: the shape each platform shows best in the feed. Video platforms get no image. */
export const DEFAULT_IMAGE_SIZES: Record<Platform, ImageSize> = {
  linkedin: "landscape",
  x: "landscape",
  instagram: "portrait",
  facebook: "square",
  threads: "portrait",
  bluesky: "landscape",
  mastodon: "landscape",
  tiktok: "none",
  youtube_shorts: "none",
};
export const SIZE_PIXELS: Record<Exclude<ImageSize, "none">, { w: number; h: number }> = {
  square: { w: 1080, h: 1080 },
  portrait: { w: 1080, h: 1350 },
  landscape: { w: 1200, h: 675 },
};
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The storage Showrium needs (an R2 bucket fits). */
export interface ImageStore {
  put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
  delete(key: string): Promise<void>;
}

export class ImageError extends Error {
  constructor(
    readonly code: "not_found" | "invalid" | "too_large" | "unsupported_type" | "locked" | "unavailable" | "limit",
    message: string,
  ) {
    super(message);
    this.name = "ImageError";
  }
}

// --- Settings ----------------------------------------------------------------------------------

export async function getImageSettings(db: Db, orgId: string) {
  const [row] = await db.select().from(imageSetting).where(eq(imageSetting.orgId, orgId));
  return { sizes: { ...DEFAULT_IMAGE_SIZES, ...(row?.sizes ?? {}) }, auto: row?.auto ?? true, allowAi: row?.allowAi ?? true };
}

export async function saveImageSettings(db: Db, orgId: string, input: { sizes: Partial<Record<Platform, ImageSize>>; auto: boolean; allowAi: boolean }) {
  const values = { sizes: input.sizes, auto: input.auto, allowAi: input.allowAi };
  await db.insert(imageSetting).values({ orgId, ...values }).onConflictDoUpdate({ target: imageSetting.orgId, set: { ...values, updatedAt: new Date() } });
  return getImageSettings(db, orgId);
}

// --- Files ------------------------------------------------------------------------------------

/** The image type from the file's own bytes (the claimed type is never trusted). */
export function detectImageType(b: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | "image/gif" | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  if (String.fromCharCode(...b.slice(0, 4)) === "GIF8") return "image/gif";
  return null;
}
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

/** Width and height from the file header (JPEG, PNG, WebP, GIF), when it can be read cheaply. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const type = detectImageType(b);
  const u16 = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const u32 = (i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
  if (type === "image/png" && b.length > 24) return { width: u32(16), height: u32(20) };
  if (type === "image/gif" && b.length > 10) return { width: b[6]! | (b[7]! << 8), height: b[8]! | (b[9]! << 8) };
  if (type === "image/webp" && b.length > 30) {
    const chunk = String.fromCharCode(...b.slice(12, 16));
    if (chunk === "VP8X") return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    if (chunk === "VP8 ") return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff };
    if (chunk === "VP8L") return { width: 1 + (((b[22]! & 0x3f) << 8) | b[21]!), height: 1 + (((b[24]! & 0xf) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6)) };
  }
  if (type === "image/jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      const len = u16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: u16(i + 5), width: u16(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

export async function getDraftImage(db: Db, orgId: string, draftId: string) {
  const [row] = await db.select({ image: draft.image, status: draft.status }).from(draft).where(and(eq(draft.orgId, orgId), eq(draft.id, draftId)));
  return row ?? null;
}

/**
 * Stores an image for a post (replacing any earlier one). The type is checked from the bytes;
 * published posts can't change their image.
 */
export async function storeDraftImage(
  db: Db,
  store: ImageStore,
  orgId: string,
  draftId: string,
  input: { bytes: Uint8Array; source: ImageSource; alt: string; aiGenerated?: boolean | undefined; sourceUrl?: string | undefined },
): Promise<PostImage> {
  const current = await getDraftImage(db, orgId, draftId);
  if (!current) throw new ImageError("not_found", "No such post in this workspace.");
  if (current.status === "published" || current.status === "publishing") throw new ImageError("locked", "Published posts keep their image.");
  if (!input.bytes.byteLength || input.bytes.byteLength > MAX_IMAGE_BYTES) throw new ImageError("too_large", "Images can be up to 5 MB.");
  const mime = detectImageType(input.bytes);
  if (!mime) throw new ImageError("unsupported_type", "Use a JPG, PNG, WebP or GIF image.");
  const size = imageSize(input.bytes);
  const key = `orgs/${orgId}/images/${draftId}-${newId("img").slice(4)}.${EXT[mime]}`;
  await store.put(key, input.bytes, { httpMetadata: { contentType: mime } });
  const image: PostImage = {
    key,
    source: input.source,
    alt: input.alt.trim().slice(0, 1000),
    mime,
    bytes: input.bytes.byteLength,
    ...(size ? { width: size.width, height: size.height } : {}),
    aiGenerated: input.aiGenerated ?? input.source === "ai",
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
  };
  const updated = await db
    .update(draft)
    .set({ image, updatedAt: new Date() })
    .where(and(eq(draft.orgId, orgId), eq(draft.id, draftId), inArray(draft.status, ["draft", "approved", "scheduled", "failed", "discarded"])))
    .returning({ id: draft.id });
  if (!updated.length) {
    await store.delete(key);
    throw new ImageError("locked", "Published posts keep their image.");
  }
  if (current.image?.key && current.image.key !== key) await store.delete(current.image.key).catch(() => undefined);
  return image;
}

export async function updateImageAlt(db: Db, orgId: string, draftId: string, alt: string) {
  const current = await getDraftImage(db, orgId, draftId);
  if (!current?.image) throw new ImageError("not_found", "This post has no image.");
  if (current.status === "published" || current.status === "publishing") throw new ImageError("locked", "Published posts keep their image.");
  const image = { ...current.image, alt: alt.trim().slice(0, 1000) };
  await db.update(draft).set({ image, updatedAt: new Date() }).where(and(eq(draft.orgId, orgId), eq(draft.id, draftId)));
  return image;
}

export async function removeDraftImage(db: Db, store: ImageStore, orgId: string, draftId: string) {
  const current = await getDraftImage(db, orgId, draftId);
  if (!current) throw new ImageError("not_found", "No such post in this workspace.");
  if (current.status === "published" || current.status === "publishing") throw new ImageError("locked", "Published posts keep their image.");
  await db.update(draft).set({ image: null, updatedAt: new Date() }).where(and(eq(draft.orgId, orgId), eq(draft.id, draftId)));
  if (current.image?.key) await store.delete(current.image.key).catch(() => undefined);
}

// --- Finding an image -------------------------------------------------------------------------

/** The page's own preview image (og:image / twitter:image), fetched safely. */
export async function findLinkImage(pageUrl: string, doFetch?: FetchLike): Promise<{ bytes: Uint8Array; url: string; alt: string } | null> {
  const page = await safeFetchText(pageUrl, { fetch: doFetch, maxBytes: 1_500_000, allowedTypes: /text\/html|application\/xhtml/ });
  const tags = [...page.text.matchAll(/<meta\b[^<>]*>/gi)].map((m) => m[0]);
  const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"))?.[1] ?? null;
  const find = (...names: string[]) => {
    for (const n of names) {
      const tag = tags.find((t) => [attr(t, "property"), attr(t, "name")].some((v) => v?.toLowerCase() === n));
      const content = tag ? attr(tag, "content") : null;
      if (content) return content;
    }
    return null;
  };
  const src = find("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src");
  if (!src) return null;
  const url = new URL(src.replace(/&amp;/g, "&"), page.url).toString();
  const img = await safeFetchBytes(url, { fetch: doFetch, maxBytes: MAX_IMAGE_BYTES, accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8", allowedTypes: /^image\/(jpeg|png|webp|gif)/ });
  if (!detectImageType(img.bytes)) return null;
  const size = imageSize(img.bytes);
  if (size && (size.width < 200 || size.height < 100)) return null; // icons and tracking pixels aren't post images
  const alt = find("og:image:alt", "twitter:image:alt") ?? find("og:title", "twitter:title") ?? "";
  return { bytes: img.bytes, url: img.url, alt: alt.replace(/&amp;/g, "&").slice(0, 300) };
}

/** A screenshot of the page through Cloudflare Browser Rendering (only when it's set up). */
export async function screenshotPage(pageUrl: string, cfg: { accountId: string; token: string }, doFetch: FetchLike = fetch): Promise<Uint8Array | null> {
  const url = assertSafeUrl(pageUrl).toString();
  const res = await doFetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.accountId)}/browser-rendering/screenshot`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, viewport: { width: 1200, height: 675 }, gotoOptions: { waitUntil: "networkidle2", timeout: 15000 }, screenshotOptions: { type: "jpeg", quality: 85 } }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  return detectImageType(bytes) && bytes.byteLength <= MAX_IMAGE_BYTES ? bytes : null;
}

/** The prompt for an AI image: an illustration of the post's idea, never text, logos or real people. */
export function aiImagePrompt(postText: string): string {
  const idea = postText.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 400);
  return [
    "A clean, modern editorial illustration for a social media post.",
    `The post is about: ${idea}`,
    "Warm, optimistic colours. Simple shapes. No text, no letters, no numbers, no logos, no brand names, no real or recognisable people, no faces.",
  ].join(" ");
}

type AiLike = { run(model: string, input: Record<string, unknown>): Promise<unknown> };

export async function generateAiImage(ai: AiLike, postText: string): Promise<Uint8Array | null> {
  const out = (await ai.run("@cf/black-forest-labs/flux-1-schnell", { prompt: aiImagePrompt(postText), steps: 6 })) as { image?: string };
  if (!out?.image) return null;
  const bytes = Uint8Array.from(atob(out.image), (c) => c.charCodeAt(0));
  return detectImageType(bytes) ? bytes : null;
}

/** AI images per day: the plan's daily upload allowance (they cost real money). Counted per brief. */
export async function aiImagesToday(db: Db, orgId: string, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [row] = await db
    .select({ n: sql<number>`count(DISTINCT ${draft.briefId})` })
    .from(draft)
    .where(and(eq(draft.orgId, orgId), gte(draft.updatedAt, start), sql`json_extract(${draft.image}, '$.source') = 'ai'`));
  return Number(row?.n ?? 0);
}

export interface ImageDeps {
  db: Db;
  store: ImageStore;
  fetch?: FetchLike | undefined;
  ai?: AiLike | undefined;
  screenshot?: { accountId: string; token: string } | undefined;
}

/** Finds one image for a set of posts from the same material, trying each source in order. */
export async function findImage(
  deps: ImageDeps,
  orgId: string,
  ctx: { kind: string; title: string; url: string | null; mediaKey: string | null },
  postText: string,
  opts: { allowAi: boolean; only?: ImageSource | undefined },
): Promise<{ bytes: Uint8Array; source: ImageSource; alt: string; sourceUrl?: string } | null> {
  const want = (s: ImageSource) => !opts.only || opts.only === s;
  // 1. The person's own photo.
  if (want("upload") && ctx.kind === "photo" && ctx.mediaKey) {
    const obj = await deps.store.get(ctx.mediaKey);
    if (obj) {
      const bytes = new Uint8Array(await obj.arrayBuffer());
      if (detectImageType(bytes) && bytes.byteLength <= MAX_IMAGE_BYTES) return { bytes, source: "upload", alt: ctx.title || "Photo" };
    }
  }
  // 2. The link's own preview image.
  if (want("link") && ctx.url) {
    try {
      const found = await findLinkImage(ctx.url, deps.fetch);
      if (found) return { bytes: found.bytes, source: "link", alt: found.alt || ctx.title, sourceUrl: ctx.url };
    } catch {
      // Unreachable page or image: try the next source.
    }
  }
  // 3. A screenshot of the page.
  if (want("screenshot") && ctx.url && deps.screenshot) {
    try {
      const bytes = await screenshotPage(ctx.url, deps.screenshot, deps.fetch);
      if (bytes) return { bytes, source: "screenshot", alt: `Screenshot of ${ctx.title || new URL(ctx.url).hostname}`, sourceUrl: ctx.url };
    } catch {
      // Next source.
    }
  }
  // 4. AI, when allowed and within the daily limit.
  if (want("ai") && opts.allowAi && deps.ai) {
    const plan = await getOrgPlan(deps.db, orgId);
    if ((await aiImagesToday(deps.db, orgId)) >= PLAN_LIMITS[plan].uploadsPerDay) {
      if (opts.only === "ai") throw new ImageError("limit", `You've made today's ${PLAN_LIMITS[plan].uploadsPerDay} AI images. Try again tomorrow, or use a photo or a card.`);
      return null;
    }
    const bytes = await generateAiImage(deps.ai, postText).catch(() => null);
    if (bytes) return { bytes, source: "ai", alt: `AI-generated illustration: ${postText.split("\n")[0]!.slice(0, 200)}` };
  }
  return null;
}

/**
 * After posts are written: one image for every post in the brief that should have one (by the
 * preferred sizes) and doesn't yet. Best effort: posts without an image are still fine.
 */
export async function autoImagesForBrief(deps: ImageDeps, orgId: string, briefId: string) {
  const settings = await getImageSettings(deps.db, orgId);
  if (!settings.auto) return { attached: 0 };
  const [b] = await deps.db
    .select({ kind: contextItem.kind, title: contextItem.title, url: contextItem.url, mediaKey: contextItem.mediaKey })
    .from(brief)
    .innerJoin(contextItem, eq(contextItem.id, brief.contextItemId))
    .where(and(eq(brief.orgId, orgId), eq(brief.id, briefId)));
  if (!b) return { attached: 0 };
  const drafts = await deps.db
    .select({ id: draft.id, platform: draft.platform, text: draft.text, image: draft.image })
    .from(draft)
    .where(and(eq(draft.orgId, orgId), eq(draft.briefId, briefId), inArray(draft.status, ["draft", "approved", "scheduled"])));
  const needs = drafts.filter((d) => !d.image && settings.sizes[d.platform] !== "none");
  if (!needs.length) return { attached: 0 };
  // AI only for posts where a picture helps and nothing real exists: not for code updates, which get the link or nothing.
  const allowAi = settings.allowAi && !["github_activity"].includes(b.kind);
  const found = await findImage(deps, orgId, b, needs[0]!.text, { allowAi });
  if (!found) return { attached: 0 };
  let attached = 0;
  for (const d of needs) {
    await storeDraftImage(deps.db, deps.store, orgId, d.id, { ...found, aiGenerated: found.source === "ai" }).then(
      () => attached++,
      () => undefined,
    );
  }
  return { attached, source: found.source };
}

/** For a post that exists: find an image from its material (optionally from one source only). */
export async function findImageForDraft(deps: ImageDeps, orgId: string, draftId: string, only?: ImageSource) {
  const [row] = await deps.db
    .select({ text: draft.text, kind: contextItem.kind, title: contextItem.title, url: contextItem.url, mediaKey: contextItem.mediaKey })
    .from(draft)
    .leftJoin(brief, eq(brief.id, draft.briefId))
    .leftJoin(contextItem, eq(contextItem.id, brief.contextItemId))
    .where(and(eq(draft.orgId, orgId), eq(draft.id, draftId)));
  if (!row) throw new ImageError("not_found", "No such post in this workspace.");
  const settings = await getImageSettings(deps.db, orgId);
  const ctx = { kind: row.kind ?? "manual", title: row.title ?? "", url: row.url ?? null, mediaKey: row.mediaKey ?? null };
  const found = await findImage(deps, orgId, ctx, row.text, { allowAi: only === "ai" ? true : settings.allowAi, only });
  if (!found) {
    const why =
      only === "link" ? "That page has no preview image." : only === "screenshot" ? "Screenshots aren't set up, or the page couldn't be captured." : only === "upload" ? "This post wasn't written from a photo." : "No image found. Try a card or upload a photo.";
    throw new ImageError("unavailable", why);
  }
  return storeDraftImage(deps.db, deps.store, orgId, draftId, { ...found, aiGenerated: found.source === "ai" });
}
