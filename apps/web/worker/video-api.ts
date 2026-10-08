// Phase 4 API: video plans (timelines), edit-by-chat, voice-over, TikTok inbox upload.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { can, connectionTokens, createVideo, EncryptionUnavailableError, getVideo, listVideos, premiumProviders, reviseVideo, VideoError } from "@nextrium/core";
import { TimelineSchema } from "@nextrium/llm";
import { PlatformError, tiktokInboxUpload } from "@nextrium/platforms";
import { aiProviders } from "./ai.js";
import { publishDeps } from "./connections-api.js";
import { apiError, requirePrincipal, type AppEnv } from "./principal.js";

export const videoApi = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) return c.json(apiError("invalid_request", result.error.issues.map((i) => i.message).join("; ")), 400);
  },
});
videoApi.use("/videos", requirePrincipal);
videoApi.use("/videos/*", requirePrincipal);

const Err = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const json = <T extends z.ZodType>(schema: T, description = "OK") => ({ description, content: { "application/json": { schema } } });
const errs = {
  400: json(Err, "Invalid"),
  401: json(Err, "Not signed in"),
  402: json(Err, "Out of videos and credits"),
  403: json(Err, "Not allowed"),
  404: json(Err, "Not found"),
  409: json(Err, "Conflict"),
  503: json(Err, "Unavailable"),
};
const VideoSchema = z.object({ id: z.string(), timeline: TimelineSchema, revisions: z.number(), createdAt: z.string() }).openapi("Video");
type Row = NonNullable<Awaited<ReturnType<typeof getVideo>>>;
const toVideo = (r: Row) => ({ id: r.id, timeline: r.timeline as z.infer<typeof TimelineSchema>, revisions: r.revisions, createdAt: r.createdAt.toISOString() });

function videoErrorStatus(e: VideoError) {
  return e.code === "not_found" ? 404 : e.code === "quota_exceeded" ? 402 : e.code === "ai_unavailable" ? 503 : 409;
}

videoApi.openapi(
  createRoute({ method: "get", path: "/videos", tags: ["Video"], responses: { 200: json(z.object({ data: z.array(VideoSchema), premium: z.object({ avatar: z.boolean(), cinematic: z.boolean() }) })), ...errs } }),
  async (c) => {
    const rows = await listVideos(c.get("db"), c.get("principal").orgId);
    const premium = premiumProviders(c.env as never);
    return c.json({ data: rows.map(toVideo), premium: { avatar: Boolean(premium.avatar), cinematic: Boolean(premium.cinematic) } }, 200);
  },
);

videoApi.openapi(
  createRoute({
    method: "post",
    path: "/videos",
    tags: ["Video"],
    request: { body: { required: true, content: { "application/json": { schema: z.object({ aspect: z.enum(["9:16", "1:1", "16:9"]).default("9:16"), draftId: z.string().optional(), contextItemId: z.string().optional() }).refine((b) => Boolean(b.draftId) !== Boolean(b.contextItemId), "Give either a draftId or a contextItemId.") } } } },
    responses: { 201: json(VideoSchema, "Planned"), ...errs },
  }),
  async (c) => {
    const p = c.get("principal");
    if (!can(p.role, "content.write")) return c.json(apiError("forbidden", "Your role can't create videos."), 403);
    const providers = aiProviders(c.env);
    if (!providers.length) return c.json(apiError("ai_unavailable", "The video planner isn't configured here."), 503);
    try {
      const out = await createVideo(c.get("db"), providers, { orgId: p.orgId, ...c.req.valid("json") });
      const row = await getVideo(c.get("db"), p.orgId, out.id);
      return c.json(toVideo(row!), 201);
    } catch (error) {
      if (error instanceof VideoError) return c.json(apiError(error.code, error.message), videoErrorStatus(error));
      throw error;
    }
  },
);

videoApi.openapi(
  createRoute({ method: "get", path: "/videos/{id}", tags: ["Video"], request: { params: z.object({ id: z.string() }) }, responses: { 200: json(VideoSchema), ...errs } }),
  async (c) => {
    const row = await getVideo(c.get("db"), c.get("principal").orgId, c.req.valid("param").id);
    return row ? c.json(toVideo(row), 200) : c.json(apiError("not_found", "No such video in this workspace."), 404);
  },
);

videoApi.openapi(
  createRoute({
    method: "post",
    path: "/videos/{id}/revise",
    tags: ["Video"],
    request: { params: z.object({ id: z.string() }), body: { required: true, content: { "application/json": { schema: z.object({ instruction: z.string().trim().min(3).max(500) }) } } } },
    responses: { 200: json(VideoSchema), ...errs },
  }),
  async (c) => {
    const p = c.get("principal");
    if (!can(p.role, "content.write")) return c.json(apiError("forbidden", "Your role can't edit videos."), 403);
    try {
      await reviseVideo(c.get("db"), aiProviders(c.env), { orgId: p.orgId, id: c.req.valid("param").id, instruction: c.req.valid("json").instruction });
      return c.json(toVideo((await getVideo(c.get("db"), p.orgId, c.req.valid("param").id))!), 200);
    } catch (error) {
      if (error instanceof VideoError) return c.json(apiError(error.code, error.message), videoErrorStatus(error));
      throw error;
    }
  },
);

videoApi.openapi(
  createRoute({ method: "post", path: "/videos/{id}/voiceover", tags: ["Video"], request: { params: z.object({ id: z.string() }) }, responses: { 200: json(z.object({ audioBase64: z.string(), mime: z.string() })), ...errs } }),
  async (c) => {
    const p = c.get("principal");
    const row = await getVideo(c.get("db"), p.orgId, c.req.valid("param").id);
    if (!row) return c.json(apiError("not_found", "No such video in this workspace."), 404);
    if (!c.env.AI) return c.json(apiError("voice_unavailable", "Voice-over isn't available in this environment. The video will have captions only."), 503);
    try {
      const out = (await c.env.AI.run("@cf/myshell-ai/melotts" as never, { prompt: row.timeline.narration, lang: "en" } as never)) as { audio?: string };
      if (!out?.audio) throw new Error("empty");
      return c.json({ audioBase64: out.audio, mime: "audio/mpeg" }, 200);
    } catch {
      return c.json(apiError("voice_unavailable", "Couldn't create the voice-over right now. The video will have captions only."), 503);
    }
  },
);

// The browser uploads the rendered file; the Worker streams it to TikTok (no buffering).
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
videoApi.post("/videos/:id/tiktok-inbox", async (c) => {
  const p = c.get("principal");
  if (!can(p.role, "publish")) return c.json(apiError("forbidden", "Your role can't publish."), 403);
  const connectionId = c.req.query("connectionId") ?? "";
  const type = (c.req.header("Content-Type") ?? "").split(";")[0]!.trim();
  const size = Number(c.req.header("Content-Length") ?? "0");
  if (!["video/webm", "video/mp4"].includes(type)) return c.json(apiError("invalid_request", "Upload a WebM or MP4 video."), 400);
  if (!size || size > MAX_VIDEO_BYTES) return c.json(apiError("invalid_request", "Videos must be under 50 MB."), 400);
  if (!(await getVideo(c.get("db"), p.orgId, c.req.param("id")))) return c.json(apiError("not_found", "No such video in this workspace."), 404);
  try {
    const deps = await publishDeps(c.env, c.get("db"));
    const tokens = await connectionTokens(deps, p.orgId, connectionId, "tiktok");
    if (!tokens) return c.json(apiError("no_connection", "Connect a TikTok account first."), 409);
    const out = await tiktokInboxUpload(tokens, c.req.raw.body!, size, type);
    return c.json({ ok: true, publishId: out.publishId, message: "Sent to your TikTok inbox. Open TikTok to finish and post it." }, 200);
  } catch (error) {
    if (error instanceof EncryptionUnavailableError) return c.json(apiError("not_configured", "Connections aren't set up here."), 503);
    if (error instanceof PlatformError) return c.json(apiError("platform_error", error.message), 502);
    throw error;
  }
});
