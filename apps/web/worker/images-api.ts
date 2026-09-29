// Sprint 6 API: one image per post. Images are private (R2) and served only to members of the
// workspace, or through short-lived signed links (for downloading or opening in a new tab).
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createDb, IMAGE_SIZES, PLATFORMS, type Db, type ImageSource } from "@nextrium/db";
import {
  autoImagesForBrief,
  can,
  findImageForDraft,
  getDraftImage,
  getImageSettings,
  ImageError,
  MAX_IMAGE_BYTES,
  removeDraftImage,
  saveImageSettings,
  storeDraftImage,
  updateImageAlt,
  type ImageDeps,
} from "@nextrium/core";
import type { Env } from "./env.js";
import { apiError, requirePrincipal, type AppEnv } from "./principal.js";

export const imagesApi = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) return c.json(apiError("invalid_request", result.error.issues[0]?.message ?? "Invalid request."), 400);
  },
});
for (const path of ["/image-settings", "/drafts/:id/image", "/drafts/:id/image/*"]) imagesApi.use(path, requirePrincipal);

const Err = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const json = <T extends z.ZodType>(schema: T, description = "OK") => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { required: true, content: { "application/json": { schema } } } });
const errs = { 400: json(Err, "Invalid"), 401: json(Err, "Not signed in"), 403: json(Err, "Not allowed"), 404: json(Err, "Not found"), 409: json(Err, "Conflict") };

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
  return e.code === "not_found" ? 404 : e.code === "too_large" ? 413 : e.code === "unsupported_type" ? 415 : e.code === "limit" ? 429 : e.code === "unavailable" ? 422 : 409;
}

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

// --- One post's image ------------------------------------------------------------------------------

const ImageOut = z.object({ source: z.string(), alt: z.string(), mime: z.string(), bytes: z.number(), width: z.number().optional(), height: z.number().optional(), aiGenerated: z.boolean(), sourceUrl: z.string().optional() }).openapi("PostImage");
const publicImage = (img: { key: string } & z.infer<typeof ImageOut>) => {
  const { key: _key, ...rest } = img;
  return rest;
};

/** The image file itself, for members of the workspace. */
imagesApi.get("/drafts/:id/image", async (c) => {
  const p = c.get("principal");
  const row = await getDraftImage(c.get("db"), p.orgId, c.req.param("id"));
  if (!row?.image || !c.env.MEDIA) return c.json(apiError("not_found", "This post has no image."), 404);
  const obj = await c.env.MEDIA.get(row.image.key);
  if (!obj) return c.json(apiError("not_found", "This post has no image."), 404);
  return serve(obj, `showrium-${c.req.param("id")}.${row.image.key.split(".").pop()}`, c.req.query("download") === "1");
});

/** A link that works for 15 minutes without signing in (to download, or open on a phone). */
imagesApi.openapi(
  createRoute({ method: "post", path: "/drafts/{id}/image/link", tags: ["Images"], request: { params: z.object({ id: z.string() }) }, responses: { 200: json(z.object({ url: z.string(), expiresAt: z.string() })), ...errs } }),
  async (c) => {
    const p = c.get("principal");
    const id = c.req.valid("param").id;
    const row = await getDraftImage(c.get("db"), p.orgId, id);
    if (!row?.image) return c.json(apiError("not_found", "This post has no image."), 404);
    const exp = Date.now() + 15 * 60_000;
    const sig = await sign(c.env, `${p.orgId}.${id}.${row.image.key}.${exp}`);
    return c.json({ url: `/api/v1/signed-images/${encodeURIComponent(p.orgId)}/${encodeURIComponent(id)}?exp=${exp}&sig=${sig}`, expiresAt: new Date(exp).toISOString() }, 200);
  },
);

/** Signed links: checked against the image the post has now, so a replaced image's old link stops working. */
imagesApi.get("/signed-images/:org/:id", async (c) => {
  const exp = Number(c.req.query("exp") ?? "0");
  const sig = c.req.query("sig") ?? "";
  if (!Number.isFinite(exp) || exp < Date.now() || exp > Date.now() + 16 * 60_000 || !sig) return c.json(apiError("expired", "This link has expired."), 403);
  // No sign-in here (that's the point of the link), so the handle to the database is made here.
  const row = await getDraftImage(createDb(c.env.DB), c.req.param("org"), c.req.param("id"));
  if (!row?.image || !c.env.MEDIA) return c.json(apiError("not_found", "Not found."), 404);
  if (!same(sig, await sign(c.env, `${c.req.param("org")}.${c.req.param("id")}.${row.image.key}.${exp}`))) return c.json(apiError("expired", "This link has expired."), 403);
  const obj = await c.env.MEDIA.get(row.image.key);
  if (!obj) return c.json(apiError("not_found", "Not found."), 404);
  return serve(obj, `showrium-${c.req.param("id")}.${row.image.key.split(".").pop()}`, c.req.query("download") === "1");
});

imagesApi.openapi(
  createRoute({
    method: "post",
    path: "/drafts/{id}/image/find",
    tags: ["Images"],
    request: { params: z.object({ id: z.string() }), ...body(z.object({ source: z.enum(["upload", "link", "screenshot", "ai"]).optional() })) },
    responses: { 200: json(z.object({ image: ImageOut })), 413: json(Err, "Too large"), 415: json(Err, "Not an image"), 422: json(Err, "Nothing found"), 429: json(Err, "Daily limit"), ...errs },
  }),
  async (c) => {
    const p = c.get("principal");
    if (!can(p.role, "content.write")) return c.json(apiError("forbidden", "Your role can't change images."), 403);
    const deps = imageDeps(c.env, c.get("db"));
    if (!deps) return c.json(apiError("unavailable", "Images aren't set up in this environment."), 422);
    try {
      const image = await findImageForDraft(deps, p.orgId, c.req.valid("param").id, c.req.valid("json").source);
      return c.json({ image: publicImage(image) }, 200);
    } catch (error) {
      if (error instanceof ImageError) return c.json(apiError(error.code, error.message), imageErrorStatus(error));
      throw error;
    }
  },
);

/** Upload a photo, or an image made in the browser (a designed card, or a crop to the preferred size). */
imagesApi.put("/drafts/:id/image", async (c) => {
  const p = c.get("principal");
  if (!can(p.role, "content.write")) return c.json(apiError("forbidden", "Your role can't change images."), 403);
  if (!c.env.MEDIA) return c.json(apiError("unavailable", "Images aren't set up in this environment."), 422);
  if (Number(c.req.header("Content-Length") ?? 0) > MAX_IMAGE_BYTES + 64 * 1024) return c.json(apiError("too_large", "Images can be up to 5 MB."), 413);
  let form: Record<string, string | File>;
  try {
    form = (await c.req.parseBody()) as Record<string, string | File>;
  } catch {
    return c.json(apiError("invalid_request", "Send the image as a form upload."), 400);
  }
  const file = form.file;
  if (!(file instanceof File)) return c.json(apiError("invalid_request", "Choose an image."), 400);
  const source = form.source === "card" ? "card" : form.source === "crop" ? "crop" : "upload";
  const alt = typeof form.alt === "string" ? form.alt : "";
  const current = await getDraftImage(c.get("db"), p.orgId, c.req.param("id"));
  try {
    // A crop keeps the original's source and label (an AI image stays marked as AI).
    const base: { source: ImageSource; aiGenerated: boolean; sourceUrl: string | undefined } =
      source === "crop" && current?.image
        ? { source: current.image.source, aiGenerated: current.image.aiGenerated, sourceUrl: current.image.sourceUrl }
        : { source: source === "card" ? "card" : "upload", aiGenerated: false, sourceUrl: undefined };
    const image = await storeDraftImage(c.get("db"), c.env.MEDIA, p.orgId, c.req.param("id"), { bytes: new Uint8Array(await file.arrayBuffer()), alt: alt || current?.image?.alt || "", ...base });
    return c.json({ image: publicImage(image) }, 200);
  } catch (error) {
    if (error instanceof ImageError) return c.json(apiError(error.code, error.message), imageErrorStatus(error));
    throw error;
  }
});

imagesApi.openapi(
  createRoute({ method: "patch", path: "/drafts/{id}/image", tags: ["Images"], request: { params: z.object({ id: z.string() }), ...body(z.object({ alt: z.string().max(1000) })) }, responses: { 200: json(z.object({ image: ImageOut })), ...errs } }),
  async (c) => {
    const p = c.get("principal");
    if (!can(p.role, "content.write")) return c.json(apiError("forbidden", "Your role can't change images."), 403);
    try {
      return c.json({ image: publicImage(await updateImageAlt(c.get("db"), p.orgId, c.req.valid("param").id, c.req.valid("json").alt)) }, 200);
    } catch (error) {
      if (error instanceof ImageError) return c.json(apiError(error.code, error.message), error.code === "not_found" ? 404 : 409);
      throw error;
    }
  },
);

imagesApi.openapi(
  createRoute({ method: "delete", path: "/drafts/{id}/image", tags: ["Images"], request: { params: z.object({ id: z.string() }) }, responses: { 204: { description: "Removed" }, ...errs } }),
  async (c) => {
    const p = c.get("principal");
    if (!can(p.role, "content.write")) return c.json(apiError("forbidden", "Your role can't change images."), 403);
    if (!c.env.MEDIA) return c.json(apiError("not_found", "This post has no image."), 404);
    try {
      await removeDraftImage(c.get("db"), c.env.MEDIA, p.orgId, c.req.valid("param").id);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof ImageError) return c.json(apiError(error.code, error.message), error.code === "not_found" ? 404 : 409);
      throw error;
    }
  },
);
