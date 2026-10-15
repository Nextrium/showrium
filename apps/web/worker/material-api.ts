// Sprint 2 API: the daily prompt, and uploading photos and documents as material to write from.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  addUploadedContext,
  answerPrompt,
  can,
  createIdeas,
  CREDITS_PER_EXTRA_UPLOAD,
  getBalance,
  getOrgLimits,
  getOrgPlan,
  getPersona,
  InsufficientCreditsError,
  newId,
  PLAN_LIMITS,
  postCreditTxn,
  promptFor,
  PromptError,
  todaysAnswer,
  uploadsToday,
} from "@nextrium/core";
import type { Db } from "@nextrium/db";
import { apiError, requirePrincipal, type AppEnv } from "./principal.js";

export const materialApi = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) return c.json(apiError("invalid_request", result.error.issues.map((i) => i.message).join("; ")), 400);
  },
});
for (const path of ["/prompt", "/prompt/*", "/contexts/upload", "/contexts/upload/*"]) materialApi.use(path, requirePrincipal);

const Err = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const json = <T extends z.ZodType>(schema: T, description = "OK") => ({ description, content: { "application/json": { schema } } });
const errs = { 400: json(Err, "Invalid"), 401: json(Err, "Not signed in"), 403: json(Err, "Not allowed"), 409: json(Err, "Conflict") };

// --- Daily prompt ----------------------------------------------------------------------------

materialApi.openapi(
  createRoute({ method: "get", path: "/prompt", tags: ["Content"], responses: { 200: json(z.object({ question: z.string(), day: z.string(), answeredContextId: z.string().nullable() })), ...errs } }),
  async (c) => {
    const { orgId } = c.get("principal");
    const persona = await getPersona(c.get("db"), orgId);
    const p = promptFor(orgId, persona?.role ?? "");
    return c.json({ ...p, answeredContextId: await todaysAnswer(c.get("db"), orgId, p.day) }, 200);
  },
);

materialApi.openapi(
  createRoute({
    method: "post",
    path: "/prompt/answer",
    tags: ["Content"],
    request: { body: { required: true, content: { "application/json": { schema: z.object({ answer: z.string().trim().min(10, "Write at least a sentence.").max(2000) }) } } } },
    responses: { 201: json(z.object({ contextItemId: z.string() }), "Saved as an idea"), ...errs },
  }),
  async (c) => {
    const p = c.get("principal");
    if (!can(p.role, "content.write")) return c.json(apiError("forbidden", "Your role can't add material."), 403);
    const persona = await getPersona(c.get("db"), p.orgId);
    // The question is recomputed on the server, never taken from the request.
    const today = promptFor(p.orgId, persona?.role ?? "");
    try {
      return c.json({ contextItemId: await answerPrompt(c.get("db"), p.orgId, { ...today, answer: c.req.valid("json").answer }) }, 201);
    } catch (error) {
      if (error instanceof PromptError) return c.json(apiError("already_answered", error.message), 409);
      throw error;
    }
  },
);

// --- Uploads -------------------------------------------------------------------------------------

const MAX_BYTES = 10 * 1024 * 1024;
type Kind = { kind: "photo" | "document"; ext: string; magic: (b: Uint8Array) => boolean };
const TYPES: Record<string, Kind> = {
  "image/jpeg": { kind: "photo", ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/png": { kind: "photo", ext: "png", magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  "image/webp": { kind: "photo", ext: "webp", magic: (b) => String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP" },
  "application/pdf": { kind: "document", ext: "pdf", magic: (b) => String.fromCharCode(...b.slice(0, 5)) === "%PDF-" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { kind: "document", ext: "docx", magic: (b) => b[0] === 0x50 && b[1] === 0x4b },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": { kind: "document", ext: "pptx", magic: (b) => b[0] === 0x50 && b[1] === 0x4b },
  "text/plain": { kind: "document", ext: "txt", magic: (b) => !b.slice(0, 4096).includes(0) },
  "text/markdown": { kind: "document", ext: "md", magic: (b) => !b.slice(0, 4096).includes(0) },
};
export const UPLOAD_TYPES = Object.keys(TYPES);

async function uploadAllowance(db: Db, orgId: string) {
  const [{ limits }, used, balance] = await Promise.all([getOrgLimits(db, orgId), uploadsToday(db, orgId), getBalance(db, orgId)]);
  return { used, limit: limits.uploadsPerDay, creditsPerExtra: CREDITS_PER_EXTRA_UPLOAD, balance };
}

materialApi.get("/contexts/upload/allowance", async (c) => c.json(await uploadAllowance(c.get("db"), c.get("principal").orgId), 200));

materialApi.post("/contexts/upload", async (c) => {
  const p = c.get("principal");
  if (!can(p.role, "content.write")) return c.json(apiError("forbidden", "Your role can't add material."), 403);
  if (Number(c.req.header("Content-Length") ?? 0) > MAX_BYTES + 64 * 1024) return c.json(apiError("too_large", "Files can be up to 10 MB."), 413);
  const db = c.get("db");
  // Beyond the plan's daily uploads, each upload costs credits (checked now, charged once it's read).
  const allowance = await uploadAllowance(db, p.orgId);
  const extra = allowance.used >= allowance.limit;
  if (extra && allowance.balance < CREDITS_PER_EXTRA_UPLOAD) {
    return c.json(apiError("quota_exceeded", `You've used today's ${allowance.limit} uploads. Extra uploads cost ${CREDITS_PER_EXTRA_UPLOAD} credits each: add credits in Billing, or upload again tomorrow.`), 402);
  }

  let form: Record<string, string | File>;
  try {
    form = (await c.req.parseBody()) as Record<string, string | File>;
  } catch {
    return c.json(apiError("invalid_request", "Send the file as a form upload."), 400);
  }
  const file = form.file;
  const caption = typeof form.caption === "string" ? form.caption.trim().slice(0, 1000) : "";
  if (!(file instanceof File)) return c.json(apiError("invalid_request", "Choose a file to upload."), 400);
  if (file.size === 0 || file.size > MAX_BYTES) return c.json(apiError("too_large", "Files can be up to 10 MB."), 413);
  const type = TYPES[file.type.split(";")[0]!.trim().toLowerCase()];
  const bytes = new Uint8Array(await file.arrayBuffer());
  // The claimed type must match the file's actual bytes.
  if (!type || !type.magic(bytes)) return c.json(apiError("unsupported_type", "Upload a photo (JPG, PNG, WebP) or a document (PDF, Word, PowerPoint, text)."), 415);

  // Text: from the file itself, or read by Workers AI (documents free; photos described by a vision model).
  let text = "";
  if (type.ext === "txt" || type.ext === "md") {
    text = new TextDecoder().decode(bytes);
  } else if (c.env.AI) {
    try {
      const out = await c.env.AI.toMarkdown(
        { name: `upload.${type.ext}`, blob: new Blob([bytes], { type: file.type }) },
        { conversionOptions: { pdf: { images: { convert: false } }, docx: { images: { convert: false } } } },
      );
      if (out.format === "error") throw new Error(out.error);
      text = out.data;
    } catch (error) {
      console.warn("upload conversion failed", error instanceof Error ? error.message : error);
      if (type.kind === "document") return c.json(apiError("unreadable", "We couldn't read that document. Try a PDF or paste the text instead."), 422);
    }
  } else if (type.kind === "document") {
    return c.json(apiError("ai_unavailable", "Reading documents isn't available in this environment. Paste the text instead."), 503);
  }
  if (type.kind === "photo" && !caption && !text.trim()) {
    return c.json(apiError("caption_needed", "Add a line about the photo (what it shows, why it matters)."), 400);
  }

  const uploadId = newId("ctx");
  if (extra) {
    try {
      await postCreditTxn(db, { orgId: p.orgId, kind: "spend", amount: -CREDITS_PER_EXTRA_UPLOAD, idempotencyKey: `upload:${uploadId}`, description: "Extra upload" });
    } catch (error) {
      if (error instanceof InsufficientCreditsError) return c.json(apiError("quota_exceeded", `Extra uploads cost ${CREDITS_PER_EXTRA_UPLOAD} credits each. Add credits in Billing.`), 402);
      throw error;
    }
  }

  // Keep the original privately, so a photo can become the post's image later.
  let mediaKey: string | null = null;
  if (c.env.MEDIA) {
    mediaKey = `orgs/${p.orgId}/uploads/${uploadId}.${type.ext}`;
    await c.env.MEDIA.put(mediaKey, bytes, { httpMetadata: { contentType: file.type } });
  }
  const title = caption ? caption.split("\n")[0]!.slice(0, 120) : type.kind === "photo" ? "Photo" : (file.name || "Document").replace(/\.[a-z0-9]+$/i, "").slice(0, 120);
  const body = [caption, text.trim() && (type.kind === "photo" ? `What the photo shows:\n${text.trim()}` : text.trim())].filter(Boolean).join("\n\n");
  const row = await addUploadedContext(db, p.orgId, { kind: type.kind, title, body, mediaKey });
  await createIdeas(db, p.orgId, type.kind, [row], type.kind === "photo" ? "Your photo" : "Your document");
  return c.json({ id: row.id, kind: type.kind, title: row.title, chars: body.length, stored: Boolean(mediaKey), creditsSpent: extra ? CREDITS_PER_EXTRA_UPLOAD : 0 }, 201);
});
