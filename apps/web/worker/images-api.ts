// Post images: up to 4 per post. By default the posts written from the same material share one set;
// a post can switch to its own set. Images are private (R2) and served only to members of the
// workspace, or through short-lived signed links (for downloading or opening on a phone).
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createDb, IMAGE_SIZES, PLATFORMS, type Db } from "@nextrium/db";
import {
  addDraftImage,
  autoImagesForBrief,
  can,
  clearImageVariant,
  deleteImage,
  fileFor,
  findImageForDraft,
  getImage,
  getImageSettings,
  ImageError,
  listDraftImages,
  MAX_IMAGE_BYTES,
  saveImageSettings,
  setImageVariant,
  setOwnImages,
  updateImage,
  type ImageDeps,
  type ImageRow,
} from "@nextrium/core";
import type { Env } from "./env.js";
import { apiError, requirePrincipal, type AppEnv } from "./principal.js";

export const imagesApi = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) return c.json(apiError("invalid_request", result.error.issues[0]?.message ?? "Invalid request."), 400);
  },
});
for (const path of ["/image-settings", "/drafts/:id/images", "/drafts/:id/images/*", "/images/*"]) imagesApi.use(path, requirePrincipal);

const Err = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const json = <T extends z.ZodType>(schema: T, description = "OK") => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { required: true, content: { "application/json": { schema } } } });
const errs = { 400: json(Err, "Invalid"), 401: json(Err, "Not signed in"), 403: json(Err, "Not allowed"), 404: json(Err, "Not found"), 409: json(Err, "Conflict") };

const SHAPES = ["square", "portrait", "landscape"] as const;
type Shape = (typeof SHAPES)[number];

export function imageDeps(env: Env, db: Db): ImageDeps | null {
  if (!env.MEDIA) return null;
  return {
    db,
    store: env.MEDIA,
    ai: env.AI as unknown as ImageDeps["ai"],
    screenshot: env.BROWSER_RENDERING_TOKEN && env.CLOUDFLARE_ACCOUNT_ID ? { accountId: env.CLOUDFLARE_ACCOUNT_ID, token: env.BROWSER_RENDERING_TOKEN } : undefined,
  };
}

/** After posts are written: find their image in the background (never slows the reply down). */
export function findImagesLater(c: { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } }, db: Db, orgId: string, briefId: string) {
  const deps = imageDeps(c.env, db);
  if (!deps) return;
  c.executionCtx.waitUntil(autoImagesForBrief(deps, orgId, briefId).catch((e: unknown) => console.warn("auto image failed", e instanceof Error ? e.message : e)));
}

function imageErrorStatus(e: ImageError) {
  return e.code === "not_found" ? 404 : e.code === "too_large" ? 413 : e.code === "unsupported_type" ? 415 : e.code === "limit" ? 429 : e.code === "unavailable" ? 422 : e.code === "invalid" ? 400 : 409;
}

// --- What the API shows of an image (never the storage keys) --------------------------------------

const FileOut = z.object({ mime: z.string(), bytes: z.number(), width: z.number().optional(), height: z.number().optional() });
export const ImageSummary = z
  .object({
    id: z.string(),
    position: z.number(),
    source: z.string(),
    alt: z.string(),
    aiGenerated: z.boolean(),
    sourceUrl: z.string().nullable(),
    /** True when the image is shared by the posts written from the same material. */
    shared: z.boolean(),
    original: FileOut,
    /** Crops made for a shape (from the original, at full quality). */
    variants: z.partialRecord(z.enum(SHAPES), FileOut),
  })
  .openapi("PostImage");

const fileOut = (f: { mime: string; bytes: number; width?: number | undefined; height?: number | undefined }) => ({
  mime: f.mime,
  bytes: f.bytes,
  ...(f.width ? { width: f.width } : {}),
  ...(f.height ? { height: f.height } : {}),
});
export const toImageSummary = (r: ImageRow): z.infer<typeof ImageSummary> => ({
  id: r.id,
  position: r.position,
  source: r.source,
  alt: r.alt,
  aiGenerated: r.aiGenerated,
  sourceUrl: r.sourceUrl ?? null,
  shared: !r.draftId,
  original: fileOut(r.original),
  variants: Object.fromEntries(Object.entries(r.variants).filter(([k, f]) => (SHAPES as readonly string[]).includes(k) && f).map(([k, f]) => [k, fileOut(f!)])),
});

// --- Signed links ----------------------------------------------------------------------------

async function signingKey(env: Env) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(`showrium-image-links:${env.BETTER_AUTH_SECRET}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sign(env: Env, payload: string) {
  return b64url(await crypto.subtle.sign("HMAC", await signingKey(env), new TextEncoder().encode(payload)));
}
/** Constant-time comparison of two signatures. */
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function serve(obj: { body: ReadableStream; httpMetadata?: { contentType?: string } }, name: string, download: boolean) {
  const type = obj.httpMetadata?.contentType ?? "application/octet-stream";
  return new Response(obj.body, {
    headers: {
      "Content-Type": /^image\/(jpeg|png|webp|gif)$/.test(type) ? type : "application/octet-stream",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

const sizeParam = (v: string | undefined): Shape | "original" => ((SHAPES as readonly string[]).includes(v ?? "") ? (v as Shape) : "original");

async function serveImage(env: Env, row: ImageRow, size: Shape | "original", download: boolean) {
  if (!env.MEDIA) return null;
  const file = fileFor(row, size);
  const obj = await env.MEDIA.get(file.key);
  if (!obj) return null;
  return serve(obj, `showrium-${row.id}${size === "original" ? "" : `-${size}`}.${file.key.split(".").pop()}`, download);
}

// --- Settings ------------------------------------------------------------------------------------

const Settings = z.object({ sizes: z.partialRecord(z.enum(PLATFORMS), z.enum(IMAGE_SIZES)), auto: z.boolean(), allowAi: z.boolean() }).openapi("ImageSettings");

imagesApi.openapi(createRoute({ method: "get", path: "/image-settings", tags: ["Images"], responses: { 200: json(Settings), ...errs } }), async (c) =>
  c.json(await getImageSettings(c.get("db"), c.get("principal").orgId), 200),
);

imagesApi.openapi(createRoute({ method: "put", path: "/image-settings", tags: ["Images"], request: body(Settings), responses: { 200: json(Settings), ...errs } }), async (c) => {
  const p = c.get("principal");
  if (!can(p.role, "workspace.manage")) return c.json(apiError("forbidden", "Only owners and admins can change image settings."), 403);
  return c.json(await saveImageSettings(c.get("db"), p.orgId, c.req.valid("json")), 200);
});

// --- A post's images ------------------------------------------------------------------------------

const ImageSet = z.object({ own: z.boolean(), sharedWith: z.number(), images: z.array(ImageSummary) }).openapi("PostImageSet");
const toSet = (s: { own: boolean; sharedWith: number; images: ImageRow[] }) => ({ own: s.own, sharedWith: s.sharedWith, images: s.images.map(toImageSummary) });
const Id = z.object({ id: z.string().max(64) });

imagesApi.openapi(
  createRoute({ method: "get", path: "/drafts/{id}/images", tags: ["Images"], request: { params: Id }, responses: { 200: json(ImageSet), ...errs } }),
  async (c) => {
    try {
      return c.json(toSet(await listDraftImages(c.get("db"), c.get("principal").orgId, c.req.valid("param").id)), 200);
    } catch (error) {
      if (error instanceof ImageError) return c.json(apiError(error.code, error.message), 404);
      throw error;
    }
  },
);

/** Reads a form upload, refusing anything over the size limit before reading it. */
async function readUpload(c: { req: { header(name: string): string | undefined; parseBody(): Promise<unknown> } }) {
  if (Number(c.req.header("Content-Length") ?? 0) > MAX_IMAGE_BYTES + 64 * 1024) return { error: "too_large" as const };
  let form: Record<string, string | File>;
  try {
    form = (await c.req.parseBody()) as Record<string, string | File>;
  } catch {
    return { error: "invalid" as const };
  }
  if (!(form.file instanceof File)) return { error: "missing" as const };
  if (form.file.size > MAX_IMAGE_BYTES) return { error: "too_large" as const };
  return { form, bytes: new Uint8Array(await form.file.arrayBuffer()) };
}
const uploadError = (e: "too_large" | "invalid" | "missing") =>
  e === "too_large" ? ([apiError("too_large", "Images can be up to 5 MB."), 413] as const) : e === "invalid" ? ([apiError("invalid_request", "Send the image as a form upload."), 400] as const) : ([apiError("invalid_request", "Choose an image."), 400] as const);

/** Adds an uploaded photo, or a card made in the browser, to the images the post uses. */
imagesApi.post("/drafts/:id/images", async (c) => {
  const p = c.get("principal");
  if (!can(p.role, "content.write")) return c.json(apiError("forbidden", "Your role can't change images."), 403);
  if (!c.env.MEDIA) return c.json(apiError("unavailable", "Images aren't set up in this environment."), 422);
  const up = await readUpload(c);
  if ("error" in up) {
    const [err, status] = uploadError(up.error);
    return c.json(err, status);
  }
  const source = up.form.source === "card" ? "card" : "upload";
  const alt = typeof up.form.alt === "string" ? up.form.alt : "";
  try {
    const image = await addDraftImage(c.get("db"), c.env.MEDIA, p.orgId, c.req.param("id"), { bytes: up.bytes, source, alt });
    return c.json({ image: toImageSummary(image) }, 201);
  } catch (error) {
    if (error instanceof ImageError) return c.json(apiError(error.code, error.message), imageErrorStatus(error));
    throw error;
  }
});

imagesApi.openapi(
  createRoute({
    method: "post",
    path: "/drafts/{id}/images/find",
    tags: ["Images"],
    request: { params: Id, ...body(z.object({ source: z.enum(["upload", "link", "screenshot", "ai"]).optional() })) },
    responses: { 201: json(z.object({ image: ImageSummary })), 413: json(Err, "Too large"), 415: json(Err, "Not an image"), 422: json(Err, "Nothing found"), 429: json(Err, "Limit"), ...errs },
  }),
  async (c) => {
    const p = c.get("principal");
    if (!can(p.role, "content.write")) return c.json(apiError("forbidden", "Your role can't change images."), 403);
    const deps = imageDeps(c.env, c.get("db"));
    if (!deps) return c.json(apiError("unavailable", "Images aren't set up in this environment."), 422);
    try {
      const image = await findImageForDraft(deps, p.orgId, c.req.valid("param").id, c.req.valid("json").source);
      return c.json({ image: toImageSummary(image) }, 201);
    } catch (error) {
      if (error instanceof ImageError) return c.json(apiError(error.code, error.message), imageErrorStatus(error));
      throw error;
    }
  },
);

/** Use different images for this post (a copy of the shared ones to start from), or go back to sharing. */
imagesApi.openapi(
  createRoute({ method: "post", path: "/drafts/{id}/images/own", tags: ["Images"], request: { params: Id, ...body(z.object({ own: z.boolean() })) }, responses: { 200: json(ImageSet), ...errs } }),
  async (c) => {
    const p = c.get("principal");
    if (!can(p.role, "content.write")) return c.json(apiError("forbidden", "Your role can't change images."), 403);
    if (!c.env.MEDIA) return c.json(apiError("unavailable", "Images aren't set up in this environment."), 409);
    try {
      return c.json(toSet(await setOwnImages(c.get("db"), c.env.MEDIA, p.orgId, c.req.valid("param").id, c.req.valid("json").own)), 200);
    } catch (error) {
      if (error instanceof ImageError) return c.json(apiError(error.code, error.message), error.code === "not_found" ? 404 : error.code === "invalid" ? 400 : 409);
      throw error;
    }
  },
);

// --- One image ------------------------------------------------------------------------------------

/** The image file, for members of the workspace. ?size=square|portrait|landscape gives that crop (or the original). */
imagesApi.get("/images/:id", async (c) => {
  const row = await getImage(c.get("db"), c.get("principal").orgId, c.req.param("id"));
  const res = row ? await serveImage(c.env, row, sizeParam(c.req.query("size")), c.req.query("download") === "1") : null;
  return res ?? c.json(apiError("not_found", "No such image in this workspace."), 404);
});

imagesApi.openapi(
  createRoute({
    method: "patch",
    path: "/images/{id}",
    tags: ["Images"],
    request: { params: Id, ...body(z.object({ alt: z.string().max(1000).optional(), position: z.number().int().min(0).max(3).optional() })) },
    responses: { 200: json(z.object({ image: ImageSummary })), ...errs },
  }),
  async (c) => {
    const p = c.get("principal");
    if (!can(p.role, "content.write")) return c.json(apiError("forbidden", "Your role can't change images."), 403);
    try {
      return c.json({ image: toImageSummary(await updateImage(c.get("db"), p.orgId, c.req.valid("param").id, c.req.valid("json"))) }, 200);
    } catch (error) {
      if (error instanceof ImageError) return c.json(apiError(error.code, error.message), error.code === "not_found" ? 404 : 409);
      throw error;
    }
  },
);

imagesApi.openapi(
  createRoute({ method: "delete", path: "/images/{id}", tags: ["Images"], request: { params: Id }, responses: { 204: { description: "Removed" }, ...errs } }),
  async (c) => {
    const p = c.get("principal");
    if (!can(p.role, "content.write")) return c.json(apiError("forbidden", "Your role can't change images."), 403);
    if (!c.env.MEDIA) return c.json(apiError("not_found", "No such image in this workspace."), 404);
    try {
      await deleteImage(c.get("db"), c.env.MEDIA, p.orgId, c.req.valid("param").id);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof ImageError) return c.json(apiError(error.code, error.message), error.code === "not_found" ? 404 : 409);
      throw error;
    }
  },
);

/** A crop of the original to a shape, made in the browser at full quality. The original is kept. */
imagesApi.put("/images/:id/variants/:size", async (c) => {
  const p = c.get("principal");
  if (!can(p.role, "content.write")) return c.json(apiError("forbidden", "Your role can't change images."), 403);
  if (!c.env.MEDIA) return c.json(apiError("unavailable", "Images aren't set up in this environment."), 422);
  const size = c.req.param("size");
  if (!(SHAPES as readonly string[]).includes(size)) return c.json(apiError("invalid_request", "Use square, portrait or landscape."), 400);
  const up = await readUpload(c);
  if ("error" in up) {
    const [err, status] = uploadError(up.error);
    return c.json(err, status);
  }
  try {
    return c.json({ image: toImageSummary(await setImageVariant(c.get("db"), c.env.MEDIA, p.orgId, c.req.param("id"), size as Shape, up.bytes)) }, 200);
  } catch (error) {
    if (error instanceof ImageError) return c.json(apiError(error.code, error.message), imageErrorStatus(error));
    throw error;
  }
});

imagesApi.delete("/images/:id/variants/:size", async (c) => {
  const p = c.get("principal");
  if (!can(p.role, "content.write")) return c.json(apiError("forbidden", "Your role can't change images."), 403);
  if (!c.env.MEDIA) return c.json(apiError("not_found", "No such image in this workspace."), 404);
  const size = c.req.param("size");
  if (!(SHAPES as readonly string[]).includes(size)) return c.json(apiError("invalid_request", "Use square, portrait or landscape."), 400);
  try {
    return c.json({ image: toImageSummary(await clearImageVariant(c.get("db"), c.env.MEDIA, p.orgId, c.req.param("id"), size as Shape)) }, 200);
  } catch (error) {
    if (error instanceof ImageError) return c.json(apiError(error.code, error.message), error.code === "not_found" ? 404 : 409);
    throw error;
  }
});

/** A link that works for 15 minutes without signing in (to download, or open on a phone). */
imagesApi.openapi(
  createRoute({
    method: "post",
    path: "/images/{id}/link",
    tags: ["Images"],
    request: { params: Id, query: z.object({ size: z.enum(["original", ...SHAPES]).optional() }) },
    responses: { 200: json(z.object({ url: z.string(), expiresAt: z.string() })), ...errs },
  }),
  async (c) => {
    const p = c.get("principal");
    const id = c.req.valid("param").id;
    const size = c.req.valid("query").size ?? "original";
    const row = await getImage(c.get("db"), p.orgId, id);
    if (!row) return c.json(apiError("not_found", "No such image in this workspace."), 404);
    const exp = Date.now() + 15 * 60_000;
    const sig = await sign(c.env, `${p.orgId}.${id}.${size}.${fileFor(row, size).key}.${exp}`);
    return c.json({ url: `/api/v1/signed-images/${encodeURIComponent(p.orgId)}/${encodeURIComponent(id)}?size=${size}&exp=${exp}&sig=${sig}`, expiresAt: new Date(exp).toISOString() }, 200);
  },
);

/** Signed links: checked against the file the image has now, so a replaced crop's old link stops working. */
imagesApi.get("/signed-images/:org/:id", async (c) => {
  const exp = Number(c.req.query("exp") ?? "0");
  const sig = c.req.query("sig") ?? "";
  const size = sizeParam(c.req.query("size"));
  if (!Number.isFinite(exp) || exp < Date.now() || exp > Date.now() + 16 * 60_000 || !sig) return c.json(apiError("expired", "This link has expired."), 403);
  // No sign-in here (that's the point of the link), so the handle to the database is made here.
  const row = await getImage(createDb(c.env.DB), c.req.param("org"), c.req.param("id"));
  if (!row) return c.json(apiError("not_found", "Not found."), 404);
  if (!same(sig, await sign(c.env, `${c.req.param("org")}.${row.id}.${size}.${fileFor(row, size).key}.${exp}`))) return c.json(apiError("expired", "This link has expired."), 403);
  const res = await serveImage(c.env, row, size, c.req.query("download") === "1");
  return res ?? c.json(apiError("not_found", "Not found."), 404);
});
