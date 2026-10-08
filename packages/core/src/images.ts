// Sprint 6: images for posts (up to 4, shared by the posts from the same material). Sources, in order: the person's own photo → the link's own preview
// image → a screenshot of the page (when Browser Rendering is set up) → an AI image (when allowed,
// always labelled). Designed cards and crops to the preferred size are made in the browser and
// uploaded like a photo. Images are private in R2 and served only through the app.
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { brief, contextItem, draft, imageSetting, postImage, type Db, type ImageFile, type ImageSize, type ImageSource, type Platform } from "@nextrium/db";
import { chunkRows } from "./chunk.js";
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

// --- Image sets: up to 4 per material, shared by its posts --------------------------------------------

export const MAX_IMAGES = 4;
export type ImageRow = typeof postImage.$inferSelect;
type DraftRef = { id: string; briefId: string | null; ownImages: boolean; status: string; platform: Platform; text: string };
const LOCKED = ["published", "publishing"];

async function draftRef(db: Db, orgId: string, draftId: string): Promise<DraftRef | null> {
  const [d] = await db
    .select({ id: draft.id, briefId: draft.briefId, ownImages: draft.ownImages, status: draft.status, platform: draft.platform, text: draft.text })
    .from(draft)
    .where(and(eq(draft.orgId, orgId), eq(draft.id, draftId)));
  return d ?? null;
}

/** Posts without a brief (rare) always keep their own images. */
const usesOwn = (d: Pick<DraftRef, "ownImages" | "briefId">) => d.ownImages || !d.briefId;

/** The images a post uses, in order: its own, or the ones shared by every post from its material. */
export async function imageSetFor(db: Db, orgId: string, d: Pick<DraftRef, "id" | "briefId" | "ownImages">): Promise<ImageRow[]> {
  const where = usesOwn(d)
    ? and(eq(postImage.orgId, orgId), eq(postImage.draftId, d.id))
    : and(eq(postImage.orgId, orgId), eq(postImage.briefId, d.briefId!), isNull(postImage.draftId));
  return db.select().from(postImage).where(where).orderBy(asc(postImage.position), asc(postImage.createdAt));
}

/** A post's images, plus how many other posts share them. */
export async function listDraftImages(db: Db, orgId: string, draftId: string) {
  const d = await draftRef(db, orgId, draftId);
  if (!d) throw new ImageError("not_found", "No such post in this workspace.");
  const images = await imageSetFor(db, orgId, d);
  let sharedWith = 0;
  if (!usesOwn(d)) {
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(draft)
      .where(and(eq(draft.orgId, orgId), eq(draft.briefId, d.briefId!), eq(draft.ownImages, false), sql`${draft.id} <> ${d.id}`));
    sharedWith = Number(row?.n ?? 0);
  }
  return { own: usesOwn(d), sharedWith, images };
}

/** The images of many posts at once (a few queries, in chunks D1 accepts), keyed by post id. */
export async function imagesForDrafts(db: Db, orgId: string, drafts: Pick<DraftRef, "id" | "briefId" | "ownImages">[]) {
  const out = new Map<string, ImageRow[]>();
  if (!drafts.length) return out;
  const ownIds = drafts.filter(usesOwn).map((d) => d.id);
  const briefIds = [...new Set(drafts.filter((d) => !usesOwn(d)).map((d) => d.briefId!))];
  const rows: ImageRow[] = [];
  for (const chunk of chunkRows(ownIds, 2)) rows.push(...(await db.select().from(postImage).where(and(eq(postImage.orgId, orgId), inArray(postImage.draftId, chunk)))));
  for (const chunk of chunkRows(briefIds, 2)) rows.push(...(await db.select().from(postImage).where(and(eq(postImage.orgId, orgId), inArray(postImage.briefId, chunk), isNull(postImage.draftId)))));
  rows.sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime());
  for (const d of drafts) out.set(d.id, rows.filter((r) => (usesOwn(d) ? r.draftId === d.id : r.briefId === d.briefId && !r.draftId)));
  return out;
}

async function putFile(store: ImageStore, orgId: string, name: string, bytes: Uint8Array): Promise<ImageFile> {
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) throw new ImageError("too_large", "Images can be up to 5 MB.");
  const mime = detectImageType(bytes);
  if (!mime) throw new ImageError("unsupported_type", "Use a JPG, PNG, WebP or GIF image.");
  const size = imageSize(bytes);
  const key = `orgs/${orgId}/images/${name}.${EXT[mime]}`;
  await store.put(key, bytes, { httpMetadata: { contentType: mime } });
  return { key, mime, bytes: bytes.byteLength, ...(size ? { width: size.width, height: size.height } : {}) };
}

const filesOf = (row: ImageRow) => [row.original, ...Object.values(row.variants)].filter((f): f is ImageFile => Boolean(f?.key));

/** Adds an image to the set the post uses (its own, or the shared one). At most 4. */
export async function addDraftImage(
  db: Db,
  store: ImageStore,
  orgId: string,
  draftId: string,
  input: { bytes: Uint8Array; source: ImageSource; alt: string; aiGenerated?: boolean | undefined; sourceUrl?: string | undefined },
): Promise<ImageRow> {
  const d = await draftRef(db, orgId, draftId);
  if (!d) throw new ImageError("not_found", "No such post in this workspace.");
  if (LOCKED.includes(d.status)) throw new ImageError("locked", "Published posts keep their images.");
  return (await insertImage(db, store, orgId, usesOwn(d) ? { draftId: d.id } : { briefId: d.briefId! }, input))!;
}

async function insertImage(
  db: Db,
  store: ImageStore,
  orgId: string,
  owner: { draftId: string } | { briefId: string },
  input: { bytes: Uint8Array; source: ImageSource; alt: string; aiGenerated?: boolean | undefined; sourceUrl?: string | undefined },
  fixedId?: string,
): Promise<ImageRow | null> {
  const set = await db
    .select({ position: postImage.position })
    .from(postImage)
    .where("draftId" in owner ? and(eq(postImage.orgId, orgId), eq(postImage.draftId, owner.draftId)) : and(eq(postImage.orgId, orgId), eq(postImage.briefId, owner.briefId), isNull(postImage.draftId)));
  if (set.length >= MAX_IMAGES) throw new ImageError("limit", `Up to ${MAX_IMAGES} images per post. Remove one first.`);
  const id = fixedId ?? newId("img");
  const original = await putFile(store, orgId, id, input.bytes);
  const rows = await db
    .insert(postImage)
    .values({
      id,
      orgId,
      briefId: "briefId" in owner ? owner.briefId : null,
      draftId: "draftId" in owner ? owner.draftId : null,
      position: set.length ? Math.max(...set.map((s) => s.position)) + 1 : 0,
      source: input.source,
      alt: input.alt.trim().slice(0, 1000),
      original,
      aiGenerated: input.aiGenerated ?? input.source === "ai",
      sourceUrl: input.sourceUrl ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!rows[0]) {
    // Only with a fixed id: someone else added it first. Keep their file; remove ours if it differs.
    const winner = await getImage(db, orgId, id);
    if (winner?.original.key !== original.key) await store.delete(original.key).catch(() => undefined);
    return null;
  }
  return rows[0];
}

/** An image of the workspace, refusing changes when the post that owns it is published. */
async function editableImage(db: Db, orgId: string, imageId: string) {
  const [row] = await db.select().from(postImage).where(and(eq(postImage.orgId, orgId), eq(postImage.id, imageId)));
  if (!row) throw new ImageError("not_found", "No such image in this workspace.");
  if (row.draftId) {
    const d = await draftRef(db, orgId, row.draftId);
    if (d && LOCKED.includes(d.status)) throw new ImageError("locked", "Published posts keep their images.");
  }
  return row;
}

export async function getImage(db: Db, orgId: string, imageId: string) {
  const [row] = await db.select().from(postImage).where(and(eq(postImage.orgId, orgId), eq(postImage.id, imageId)));
  return row ?? null;
}

/** The file for a shape: its crop if one was made, else the original. */
export function fileFor(row: ImageRow, size?: ImageSize | "original"): ImageFile {
  return size && size !== "original" && size !== "none" ? (row.variants[size] ?? row.original) : row.original;
}

async function siblings(db: Db, orgId: string, row: ImageRow) {
  return db
    .select()
    .from(postImage)
    .where(row.draftId ? and(eq(postImage.orgId, orgId), eq(postImage.draftId, row.draftId)) : and(eq(postImage.orgId, orgId), eq(postImage.briefId, row.briefId!), isNull(postImage.draftId)))
    .orderBy(asc(postImage.position), asc(postImage.createdAt));
}

/** Changes the description, or moves the image to another place in the order. */
export async function updateImage(db: Db, orgId: string, imageId: string, patch: { alt?: string | undefined; position?: number | undefined }) {
  const row = await editableImage(db, orgId, imageId);
  if (patch.alt !== undefined) await db.update(postImage).set({ alt: patch.alt.trim().slice(0, 1000) }).where(eq(postImage.id, row.id));
  if (patch.position !== undefined) {
    const set = (await siblings(db, orgId, row)).filter((r) => r.id !== row.id);
    const at = Math.max(0, Math.min(set.length, Math.round(patch.position)));
    set.splice(at, 0, row);
    for (const [i, r] of set.entries()) if (r.position !== i) await db.update(postImage).set({ position: i }).where(eq(postImage.id, r.id));
  }
  return (await getImage(db, orgId, imageId))!;
}

export async function deleteImage(db: Db, store: ImageStore, orgId: string, imageId: string) {
  const row = await editableImage(db, orgId, imageId);
  await db.delete(postImage).where(eq(postImage.id, row.id));
  for (const f of filesOf(row)) await store.delete(f.key).catch(() => undefined);
  const rest = await siblings(db, orgId, row);
  for (const [i, r] of rest.entries()) if (r.position !== i) await db.update(postImage).set({ position: i }).where(eq(postImage.id, r.id));
}

/** Stores a crop of the original to a shape (made in the browser from the original, at full quality). */
export async function setImageVariant(db: Db, store: ImageStore, orgId: string, imageId: string, size: Exclude<ImageSize, "none">, bytes: Uint8Array) {
  const row = await editableImage(db, orgId, imageId);
  const file = await putFile(store, orgId, `${row.id}-${size}-${newId("img").slice(-6)}`, bytes);
  const old = row.variants[size];
  await db.update(postImage).set({ variants: { ...row.variants, [size]: file } }).where(eq(postImage.id, row.id));
  if (old?.key) await store.delete(old.key).catch(() => undefined);
  return (await getImage(db, orgId, imageId))!;
}

/** Removes a crop, going back to the original for that shape. */
export async function clearImageVariant(db: Db, store: ImageStore, orgId: string, imageId: string, size: Exclude<ImageSize, "none">) {
  const row = await editableImage(db, orgId, imageId);
  const old = row.variants[size];
  const variants = { ...row.variants };
  delete variants[size];
  await db.update(postImage).set({ variants }).where(eq(postImage.id, row.id));
  if (old?.key) await store.delete(old.key).catch(() => undefined);
  return (await getImage(db, orgId, imageId))!;
}

/**
 * Gives a post its own images (a copy of the shared ones, which it can then change on its own),
 * or goes back to sharing (its own images are deleted).
 */
export async function setOwnImages(db: Db, store: ImageStore, orgId: string, draftId: string, own: boolean) {
  const d = await draftRef(db, orgId, draftId);
  if (!d) throw new ImageError("not_found", "No such post in this workspace.");
  if (LOCKED.includes(d.status)) throw new ImageError("locked", "Published posts keep their images.");
  if (!d.briefId) throw new ImageError("invalid", "This post isn't linked to shared material.");
  if (own === d.ownImages) return listDraftImages(db, orgId, draftId);
  if (own) {
    const shared = await imageSetFor(db, orgId, { ...d, ownImages: false });
    for (const r of shared) {
      const copy = async (f: ImageFile, name: string) => {
        const obj = await store.get(f.key);
        if (!obj) throw new ImageError("not_found", "An image file is missing.");
        return putFile(store, orgId, name, new Uint8Array(await obj.arrayBuffer()));
      };
      const id = newId("img");
      const variants: ImageRow["variants"] = {};
      for (const [size, f] of Object.entries(r.variants) as [Exclude<ImageSize, "none">, ImageFile][]) variants[size] = await copy(f, `${id}-${size}`);
      await db.insert(postImage).values({ id, orgId, briefId: null, draftId: d.id, position: r.position, source: r.source, alt: r.alt, original: await copy(r.original, id), variants, aiGenerated: r.aiGenerated, sourceUrl: r.sourceUrl });
    }
  } else {
    const mine = await imageSetFor(db, orgId, d);
    await db.delete(postImage).where(and(eq(postImage.orgId, orgId), eq(postImage.draftId, d.id)));
    for (const r of mine) for (const f of filesOf(r)) await store.delete(f.key).catch(() => undefined);
  }
  await db.update(draft).set({ ownImages: own, updatedAt: new Date() }).where(eq(draft.id, d.id));
  return listDraftImages(db, orgId, draftId);
}

/** The image files to attach when publishing, in order, in the shape this platform shows best. */
export async function imagesForPublishing(db: Db, store: ImageStore, orgId: string, d: { id: string; briefId: string | null; ownImages: boolean; platform: Platform }) {
  const rows = (await imageSetFor(db, orgId, d)).slice(0, MAX_IMAGES);
  if (!rows.length) return [];
  const { sizes } = await getImageSettings(db, orgId);
  const size = sizes[d.platform];
  if (size === "none") return [];
  const out: { bytes: Uint8Array<ArrayBuffer>; mime: string; alt: string; width?: number | undefined; height?: number | undefined }[] = [];
  for (const r of rows) {
    const file = fileFor(r, size);
    const obj = await store.get(file.key);
    if (!obj) continue;
    // Say it's AI-made in the description too (platform labels are applied where they exist).
    const alt = r.aiGenerated && !/AI-generated/i.test(r.alt) ? `${r.alt} (AI-generated image)`.trim() : r.alt;
    out.push({ bytes: new Uint8Array(await obj.arrayBuffer()), mime: file.mime, alt, width: file.width, height: file.height });
  }
  return out;
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

/** AI images per day: the plan's daily upload allowance (they cost real money). */
export async function aiImagesToday(db: Db, orgId: string, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(postImage)
    .where(and(eq(postImage.orgId, orgId), eq(postImage.source, "ai"), gte(postImage.createdAt, start)));
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
 * After posts are written: one image for the material, shared by every post written from it.
 * Best effort: posts without an image are still fine.
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
    .select({ platform: draft.platform, text: draft.text })
    .from(draft)
    .where(and(eq(draft.orgId, orgId), eq(draft.briefId, briefId), inArray(draft.status, ["draft", "approved", "scheduled"])));
  if (!drafts.some((d) => settings.sizes[d.platform] !== "none")) return { attached: 0 };
  const existing = await deps.db.select({ id: postImage.id }).from(postImage).where(and(eq(postImage.orgId, orgId), eq(postImage.briefId, briefId), isNull(postImage.draftId)));
  if (existing.length) return { attached: 0 };
  // AI only where a picture helps and nothing real exists: not for daily code summaries.
  const allowAi = settings.allowAi && b.kind !== "github_activity";
  const found = await findImage(deps, orgId, b, drafts[0]!.text, { allowAi });
  if (!found) return { attached: 0 };
  // One automatic image per material, even if this runs twice at once (a fixed id).
  const added = await insertImage(deps.db, deps.store, orgId, { briefId }, { ...found, aiGenerated: found.source === "ai" }, `img_auto_${briefId}`);
  return added ? { attached: 1, source: found.source } : { attached: 0 };
}

/** For a post that exists: find an image from its material (optionally from one source only) and add it. */
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
  return addDraftImage(deps.db, deps.store, orgId, draftId, { ...found, aiGenerated: found.source === "ai" });
}
