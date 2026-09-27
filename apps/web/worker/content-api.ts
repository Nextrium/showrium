// Phase 2 API: persona, context, sources, voice notes, compose, drafts, usage.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { CONTENT_MODES, DRAFT_STATUSES, PLATFORMS } from "@nextrium/db";
import {
  addContextItems,
  addSource,
  assertSafeUrl,
  can,
  compose,
  ComposeError,
  DraftStateError,
  getOrgPlan,
  getPersona,
  getSource,
  getUsage,
  GITHUB_REPO_RE,
  ingestFeed,
  ingestGithubReleases,
  ingestUrl,
  listContextItems,
  listDrafts,
  listSources,
  markSourceChecked,
  PLAN_LIMITS,
  recordAudit,
  removeSource,
  savePersona,
  SourceLimitError,
  syncSource,
  UnsafeUrlError,
  updateDraft,
  type Permission,
} from "@nextrium/core";
import { PLATFORM_RULES } from "@nextrium/policy";
import { aiProviders } from "./ai.js";
import { apiError, requirePrincipal, type AppEnv } from "./principal.js";

export const contentApi = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) return c.json(apiError("invalid_request", result.error.issues.map((i) => i.message).join("; ")), 400);
  },
});

for (const path of ["/persona", "/contexts", "/contexts/*", "/sources", "/sources/*", "/compose", "/drafts", "/drafts/*", "/usage", "/platforms"]) {
  contentApi.use(path, requirePrincipal);
}

const Err = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const errs = {
  400: { description: "Invalid request", content: { "application/json": { schema: Err } } },
  401: { description: "Not signed in", content: { "application/json": { schema: Err } } },
  403: { description: "Not allowed", content: { "application/json": { schema: Err } } },
  404: { description: "Not found", content: { "application/json": { schema: Err } } },
};
const json = <T extends z.ZodType>(schema: T, description = "OK") => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { required: true, content: { "application/json": { schema } } } });

function denied(c: { get: (k: "principal") => { role: string } }, permission: Permission) {
  return !can(c.get("principal").role, permission);
}
const forbidden = (what: string) => apiError("forbidden", `Your role can't ${what} in this workspace.`);

// --- Platforms (rules for the UI) ------------------------------------------

contentApi.openapi(
  createRoute({
    method: "get",
    path: "/platforms",
    tags: ["Content"],
    responses: {
      200: json(
        z.object({
          data: z.array(
            z.object({
              id: z.enum(PLATFORMS),
              label: z.string(),
              maxLength: z.number(),
              countMethod: z.enum(["x_weighted", "graphemes", "chars"]),
              maxHashtags: z.number(),
              links: z.enum(["ok", "warn"]),
              requiresMedia: z.enum(["none", "image", "video"]),
              publishPath: z.enum(["api", "tap_to_post", "draft_inbox"]),
              aiLabel: z.string(),
            }),
          ),
        }),
      ),
    },
  }),
  (c) => c.json({ data: PLATFORMS.map((id) => ({ id, ...PLATFORM_RULES[id] })) }, 200),
);

// --- Persona ------------------------------------------------------------------

const list = (max: number) => z.array(z.string().trim().min(1).max(80)).max(max);
const PersonaSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    role: z.string().trim().max(120).default(""),
    expertise: list(15).default([]),
    interests: list(15).default([]),
    audience: z.string().trim().max(300).default(""),
    voice: z.string().trim().max(500).default(""),
    avoid: list(15).default([]),
    blockers: list(10).default([]),
    platforms: z.array(z.enum(PLATFORMS)).max(PLATFORMS.length).default([]),
    monetizationSafe: z.boolean().default(false),
  })
  .openapi("Persona");

contentApi.openapi(
  createRoute({ method: "get", path: "/persona", tags: ["Content"], responses: { 200: json(z.object({ persona: PersonaSchema.nullable() })), ...errs } }),
  async (c) => {
    const row = await getPersona(c.get("db"), c.get("principal").orgId);
    return c.json({ persona: row ? { ...row, platforms: [...new Set(row.platforms)] } : null }, 200);
  },
);

contentApi.openapi(
  createRoute({ method: "put", path: "/persona", tags: ["Content"], request: body(PersonaSchema), responses: { 200: json(z.object({ persona: PersonaSchema })), ...errs } }),
  async (c) => {
    if (denied(c, "content.write")) return c.json(forbidden("change the voice settings"), 403);
    const data = c.req.valid("json");
    const saved = await savePersona(c.get("db"), c.get("principal").orgId, { ...data, platforms: [...new Set(data.platforms)] });
    return c.json({ persona: saved! }, 200);
  },
);

// --- Context items --------------------------------------------------------------

const ContextSchema = z.object({ id: z.string(), kind: z.string(), title: z.string(), body: z.string(), url: z.string().nullable(), createdAt: z.string() }).openapi("ContextItem");
const toContext = (r: { id: string; kind: string; title: string; body: string; url: string | null; createdAt: Date }) => ({ ...r, createdAt: r.createdAt.toISOString() });

contentApi.openapi(
  createRoute({ method: "get", path: "/contexts", tags: ["Content"], responses: { 200: json(z.object({ data: z.array(ContextSchema) })), ...errs } }),
  async (c) => c.json({ data: (await listContextItems(c.get("db"), c.get("principal").orgId)).map(toContext) }, 200),
);

contentApi.openapi(
  createRoute({
    method: "post",
    path: "/contexts",
    tags: ["Content"],
    request: body(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("manual"), title: z.string().trim().max(300).default(""), body: z.string().trim().min(10).max(20000) }),
        z.object({ kind: z.literal("url"), url: z.string().trim().max(2000) }),
      ]),
    ),
    responses: { 201: json(z.object({ id: z.string(), title: z.string() }), "Created"), ...errs },
  }),
  async (c) => {
    if (denied(c, "content.write")) return c.json(forbidden("add material"), 403);
    const input = c.req.valid("json");
    const { orgId } = c.get("principal");
    let item;
    if (input.kind === "manual") {
      item = { externalId: null, title: input.title, body: input.body, url: null };
    } else {
      try {
        item = await ingestUrl(input.url);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Couldn't read that page.";
        return c.json(apiError(error instanceof UnsafeUrlError ? "unsafe_url" : "fetch_failed", message), 400);
      }
    }
    const [created] = await addContextItems(c.get("db"), orgId, input.kind, [item]);
    return c.json(created!, 201);
  },
);

// Voice notes: the browser sends the audio already base64-encoded, so the Worker never
// spends CPU encoding it (the free plan allows 10 ms of CPU per request).
const MAX_AUDIO_BASE64 = 2_800_000; // about 2 MB of audio (roughly 2 minutes of compressed speech)
contentApi.openapi(
  createRoute({
    method: "post",
    path: "/contexts/voice",
    tags: ["Content"],
    request: body(z.object({ audioBase64: z.string().min(100).max(MAX_AUDIO_BASE64).regex(/^[A-Za-z0-9+/=]+$/), title: z.string().trim().max(300).default("") })),
    responses: { 201: json(z.object({ id: z.string(), title: z.string(), body: z.string() }), "Transcribed"), 503: json(Err, "Not available"), ...errs },
  }),
  async (c) => {
    if (denied(c, "content.write")) return c.json(forbidden("add material"), 403);
    if (!c.env.AI) return c.json(apiError("voice_unavailable", "Voice notes aren't available in this environment."), 503);
    const { audioBase64, title } = c.req.valid("json");
    let text = "";
    try {
      const out = (await c.env.AI.run("@cf/openai/whisper-large-v3-turbo" as never, { audio: audioBase64 } as never)) as { text?: string };
      text = (out?.text ?? "").trim();
    } catch (error) {
      console.error("transcription failed", error);
      return c.json(apiError("transcription_failed", "We couldn't transcribe that recording. Try a clearer or shorter one."), 400);
    }
    if (text.length < 10) return c.json(apiError("transcription_empty", "We couldn't hear any speech in that recording."), 400);
    const [created] = await addContextItems(c.get("db"), c.get("principal").orgId, "voice", [{ externalId: null, title: title || "Voice note", body: text.slice(0, 20000), url: null }]);
    return c.json({ ...created!, body: text }, 201);
  },
);

// --- Sources ----------------------------------------------------------------------

const SourceSchema = z.object({ id: z.string(), kind: z.string(), key: z.string(), lastCheckedAt: z.string().nullable(), lastError: z.string().nullable() }).openapi("Source");

contentApi.openapi(
  createRoute({ method: "get", path: "/sources", tags: ["Sources"], responses: { 200: json(z.object({ data: z.array(SourceSchema) })), ...errs } }),
  async (c) => {
    const rows = await listSources(c.get("db"), c.get("principal").orgId);
    return c.json({ data: rows.map((r) => ({ id: r.id, kind: r.kind, key: r.key, lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null, lastError: r.lastError })) }, 200);
  },
);

contentApi.openapi(
  createRoute({
    method: "post",
    path: "/sources",
    tags: ["Sources"],
    request: body(z.discriminatedUnion("kind", [z.object({ kind: z.literal("github_repo"), repo: z.string().trim().regex(GITHUB_REPO_RE, "Use the form owner/repository.") }), z.object({ kind: z.literal("rss"), url: z.string().trim().max(2000) })])),
    responses: { 201: json(z.object({ id: z.string() }), "Added"), 409: json(Err, "Limit reached or already added"), ...errs },
  }),
  async (c) => {
    if (denied(c, "content.write")) return c.json(forbidden("connect sources"), 403);
    const input = c.req.valid("json");
    const { orgId } = c.get("principal");
    const key = input.kind === "github_repo" ? input.repo.toLowerCase() : input.url;
    if (input.kind === "rss") {
      try {
        assertSafeUrl(input.url);
      } catch (error) {
        return c.json(apiError("unsafe_url", error instanceof Error ? error.message : "Invalid feed address."), 400);
      }
    }
    try {
      const created = await addSource(c.get("db"), orgId, await getOrgPlan(c.get("db"), orgId), input.kind, key);
      if (!created) return c.json(apiError("already_added", "That source is already connected."), 409);
      return c.json({ id: created.id }, 201);
    } catch (error) {
      if (error instanceof SourceLimitError) return c.json(apiError("source_limit", error.message), 409);
      throw error;
    }
  },
);

contentApi.openapi(
  createRoute({ method: "delete", path: "/sources/{id}", tags: ["Sources"], request: { params: z.object({ id: z.string() }) }, responses: { 204: { description: "Removed" }, ...errs } }),
  async (c) => {
    if (denied(c, "content.write")) return c.json(forbidden("remove sources"), 403);
    const removed = await removeSource(c.get("db"), c.get("principal").orgId, c.req.valid("param").id);
    return removed ? c.body(null, 204) : c.json(apiError("not_found", "No such source in this workspace."), 404);
  },
);

contentApi.openapi(
  createRoute({
    method: "post",
    path: "/sources/{id}/sync",
    tags: ["Sources"],
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: json(z.object({ added: z.number().int(), error: z.string().nullable() })), ...errs },
  }),
  async (c) => {
    if (denied(c, "content.write")) return c.json(forbidden("sync sources"), 403);
    const { orgId } = c.get("principal");
    const src = await getSource(c.get("db"), orgId, c.req.valid("param").id);
    if (!src) return c.json(apiError("not_found", "No such source in this workspace."), 404);
    const out = await syncSource(c.get("db"), src, { githubToken: c.env.GITHUB_TOKEN });
    return c.json({ added: out.added, error: out.error }, 200);
  },
);

// --- Compose ------------------------------------------------------------------------

const DraftSchema = z
  .object({
    id: z.string(),
    briefId: z.string().nullable(),
    platform: z.enum(PLATFORMS),
    text: z.string(),
    status: z.enum(DRAFT_STATUSES),
    issues: z.array(z.object({ code: z.string(), severity: z.enum(["error", "warn"]), message: z.string() })),
    scheduledAt: z.string().nullable(),
    publishedAt: z.string().nullable(),
    externalUrl: z.string().nullable(),
    lastError: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("Draft");
type DraftRow = Awaited<ReturnType<typeof listDrafts>>[number];
export const toDraft = (d: DraftRow) => ({
  id: d.id,
  briefId: d.briefId,
  platform: d.platform,
  text: d.text,
  status: d.status,
  issues: d.issues,
  scheduledAt: d.scheduledAt?.toISOString() ?? null,
  publishedAt: d.publishedAt?.toISOString() ?? null,
  externalUrl: d.externalUrl,
  lastError: d.lastError,
  createdAt: d.createdAt.toISOString(),
});

contentApi.openapi(
  createRoute({
    method: "post",
    path: "/compose",
    tags: ["Content"],
    request: body(z.object({ contextItemId: z.string(), mode: z.enum(CONTENT_MODES), platforms: z.array(z.enum(PLATFORMS)).min(1).max(PLATFORMS.length) })),
    responses: {
      201: json(z.object({ briefId: z.string(), model: z.string(), angle: z.string(), drafts: z.array(DraftSchema) }), "Drafts created"),
      402: json(Err, "Out of posts and credits"),
      409: json(Err, "Voice not set up"),
      503: json(Err, "AI unavailable"),
      ...errs,
    },
  }),
  async (c) => {
    if (denied(c, "content.write")) return c.json(forbidden("create posts"), 403);
    const input = c.req.valid("json");
    const providers = aiProviders(c.env);
    if (!providers.length) return c.json(apiError("ai_unavailable", "The writing engine isn't configured in this environment."), 503);
    try {
      const out = await compose(c.get("db"), providers, { orgId: c.get("principal").orgId, ...input });
      return c.json({ ...out, drafts: out.drafts.map(toDraft) }, 201);
    } catch (error) {
      if (error instanceof ComposeError) {
        const status = error.code === "quota_exceeded" ? 402 : error.code === "persona_required" ? 409 : error.code === "ai_unavailable" ? 503 : error.code === "context_not_found" ? 404 : 400;
        return c.json(apiError(error.code, error.message), status);
      }
      throw error;
    }
  },
);

// --- Drafts --------------------------------------------------------------------------

contentApi.openapi(
  createRoute({
    method: "get",
    path: "/drafts",
    tags: ["Content"],
    request: { query: z.object({ status: z.enum(DRAFT_STATUSES).optional() }) },
    responses: { 200: json(z.object({ data: z.array(DraftSchema) })), ...errs },
  }),
  async (c) => {
    const { status } = c.req.valid("query");
    return c.json({ data: (await listDrafts(c.get("db"), c.get("principal").orgId, status ? { status } : {})).map(toDraft) }, 200);
  },
);

contentApi.openapi(
  createRoute({
    method: "patch",
    path: "/drafts/{id}",
    tags: ["Content"],
    request: { params: z.object({ id: z.string() }), ...body(z.object({ text: z.string().trim().min(1).max(10000).optional(), status: z.enum(["draft", "approved", "discarded"]).optional() })) },
    responses: { 200: json(z.object({ draft: DraftSchema })), 409: json(Err, "Invalid state change"), ...errs },
  }),
  async (c) => {
    const patch = c.req.valid("json");
    if (patch.text !== undefined && denied(c, "content.write")) return c.json(forbidden("edit posts"), 403);
    if (patch.status === "approved" && denied(c, "draft.approve")) return c.json(forbidden("approve posts"), 403);
    if (patch.status && patch.status !== "approved" && denied(c, "content.write")) return c.json(forbidden("change posts"), 403);
    const principal = c.get("principal");
    try {
      const updated = await updateDraft(c.get("db"), principal.orgId, c.req.valid("param").id, {
        ...(patch.text !== undefined ? { text: patch.text } : {}),
        ...(patch.status ? { status: patch.status } : {}),
      });
      if (!updated) return c.json(apiError("not_found", "No such post in this workspace."), 404);
      if (patch.status === "approved") {
        await recordAudit(c.get("db"), { orgId: principal.orgId, actorUserId: principal.kind === "user" ? principal.userId : null, actorApiKeyId: principal.kind === "api_key" ? principal.apiKeyId : null, action: "draft.approved", target: updated.id });
      }
      return c.json({ draft: toDraft(updated) }, 200);
    } catch (error) {
      if (error instanceof DraftStateError) return c.json(apiError("invalid_state", error.message), 409);
      throw error;
    }
  },
);

// --- Usage --------------------------------------------------------------------------

contentApi.openapi(
  createRoute({
    method: "get",
    path: "/usage",
    tags: ["Account"],
    responses: {
      200: json(z.object({ plan: z.string(), period: z.string(), posts: z.object({ used: z.number(), limit: z.number() }), videos: z.object({ used: z.number(), limit: z.number() }), sources: z.object({ limit: z.number() }) })),
      ...errs,
    },
  }),
  async (c) => {
    const { orgId } = c.get("principal");
    const plan = await getOrgPlan(c.get("db"), orgId);
    const usage = await getUsage(c.get("db"), orgId);
    const limits = PLAN_LIMITS[plan];
    return c.json(
      { plan, period: new Date().toISOString().slice(0, 7), posts: { used: usage.postsGenerated, limit: limits.posts }, videos: { used: usage.videosRendered, limit: limits.videos }, sources: { limit: limits.sources } },
      200,
    );
  },
);
