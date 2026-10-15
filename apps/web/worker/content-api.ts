// Phase 2 API: persona, context, sources, voice notes, compose, drafts, usage.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { CONTENT_MODES, DRAFT_STATUSES, PLATFORMS, STANCES } from "@nextrium/db";
import {
  addContextItems,
  addSource,
  assertSafeUrl,
  can,
  compose,
  ComposeError,
  DraftStateError,
  getOrgLimits,
  getOrgPlan,
  getPersona,
  getSource,
  getUsage,
  GITHUB_REPO_RE,
  ingestFeed,
  ingestUrl,
  listContextItems,
  listDrafts,
  checkTranscript,
  whisperOptions,
  imagesForDrafts,
  type ImageRow,
  autoScheduleApproved,
  draftSources,
  getDraft,
  listSources,
  markSourceChecked,
  PLAN_LIMITS,
  recordAudit,
  removeSource,
  resolveBlogSource,
  savePersona,
  SourceLimitError,
  syncSource,
  UnsafeUrlError,
  updateDraft,
  type Permission,
} from "@nextrium/core";
import { PLATFORM_RULES } from "@nextrium/policy";
import { aiProviders, researchProviders } from "./ai.js";
import { ImageSummary, findImagesLater, toImageSummary } from "./images-api.js";
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
        // "Ask the AI": the person's own instruction, followed when writing.
        z.object({ kind: z.literal("request"), body: z.string().trim().min(10).max(4000) }),
        // A voice note's transcript, checked and edited by the person before saving.
        z.object({ kind: z.literal("voice"), title: z.string().trim().max(300).default(""), body: z.string().trim().min(10).max(20000) }),
      ]),
    ),
    responses: { 201: json(z.object({ id: z.string(), title: z.string() }), "Created"), ...errs },
  }),
  async (c) => {
    if (denied(c, "content.write")) return c.json(forbidden("add material"), 403);
    const input = c.req.valid("json");
    const { orgId } = c.get("principal");
    let item;
    if (input.kind === "request") {
      item = { externalId: null, title: input.body.split("\n")[0]!.slice(0, 80), body: input.body, url: null };
    } else if (input.kind === "manual" || input.kind === "voice") {
      item = { externalId: null, title: input.title || (input.kind === "voice" ? "Voice note" : ""), body: input.body, url: null };
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
    request: body(
      z.object({
        audioBase64: z.string().min(100).max(MAX_AUDIO_BASE64).regex(/^[A-Za-z0-9+/=]+$/),
        title: z.string().trim().max(300).default(""),
        /** Names or words in the note, to help with spelling (e.g. a product name). */
        hint: z.string().trim().max(300).default(""),
        /** false: only transcribe, so the person can check and edit before it's saved. */
        save: z.boolean().default(true),
      }),
    ),
    responses: {
      200: json(z.object({ text: z.string(), unclear: z.string().nullable() }), "Transcribed, not saved"),
      201: json(z.object({ id: z.string(), title: z.string(), body: z.string() }), "Transcribed and saved"),
      422: json(Err, "Unclear recording"),
      503: json(Err, "Not available"),
      ...errs,
    },
  }),
  async (c) => {
    if (denied(c, "content.write")) return c.json(forbidden("add material"), 403);
    if (!c.env.AI) return c.json(apiError("voice_unavailable", "Voice notes aren't available in this environment."), 503);
    const { audioBase64, title, hint, save } = c.req.valid("json");
    let text = "";
    try {
      const options = whisperOptions(await getPersona(c.get("db"), c.get("principal").orgId), hint);
      type Out = { text?: string; transcription_info?: { text?: string } };
      const ai = c.env.AI;
      const out = (await ai.run("@cf/openai/whisper-large-v3-turbo" as never, { audio: audioBase64, ...options } as never).catch((error: unknown) => {
        // If the model ever refuses the tuning options, transcribe as before rather than fail.
        console.warn("transcription with options failed, retrying plain", error instanceof Error ? error.message : error);
        return ai.run("@cf/openai/whisper-large-v3-turbo" as never, { audio: audioBase64 } as never);
      })) as Out;
      text = (out?.text ?? out?.transcription_info?.text ?? "").trim();
    } catch (error) {
      console.error("transcription failed", error);
      return c.json(apiError("transcription_failed", "We couldn't transcribe that recording. Try a clearer or shorter one."), 400);
    }
    if (text.length < 10) return c.json(apiError("transcription_empty", "We couldn't hear any speech in that recording."), 400);
    const check = checkTranscript(text);
    // Shown to the person to fix; never saved (or written from) without them seeing it.
    if (!save) return c.json({ text: text.slice(0, 20000), unclear: check.ok ? null : check.reason }, 200);
    if (!check.ok) return c.json(apiError("transcription_unclear", `${check.reason} Try again somewhere quieter, or type it instead.`), 422);
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
    responses: {
      201: json(z.object({ id: z.string(), kind: z.enum(["github_repo", "rss", "page"]), key: z.string(), note: z.string().nullable() }), "Added"),
      409: json(Err, "Limit reached or already added"),
      ...errs,
    },
  }),
  async (c) => {
    if (denied(c, "content.write")) return c.json(forbidden("connect sources"), 403);
    const input = c.req.valid("json");
    const { orgId } = c.get("principal");
    let kind: "github_repo" | "rss" | "page" = input.kind;
    let key = input.kind === "github_repo" ? input.repo.toLowerCase() : input.url;
    let note: string | null = null;
    if (input.kind === "rss") {
      // People paste the blog page, not its feed: find the feed, or watch the page itself.
      try {
        assertSafeUrl(input.url);
        const resolved = await resolveBlogSource(input.url);
        kind = resolved.kind;
        key = resolved.key;
        note =
          resolved.how === "page"
            ? "This site has no feed, so Showrium watches the page for new articles."
            : resolved.how === "feed"
              ? null
              : "Found this site's feed and connected that.";
      } catch (error) {
        const message = error instanceof UnsafeUrlError ? error.message : error instanceof Error ? error.message : "We couldn't read that address.";
        return c.json(apiError("unreadable_source", message), 400);
      }
    }
    try {
      const created = await addSource(c.get("db"), orgId, await getOrgPlan(c.get("db"), orgId), kind, key);
      if (!created) return c.json(apiError("already_added", "That source is already connected."), 409);
      return c.json({ id: created.id, kind, key, note }, 201);
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
    const out = await syncSource(c.get("db"), src);
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
    /** A thread's parts in order (null for a single post), and how many have been posted. */
    parts: z.array(z.string()).nullable(),
    partsPosted: z.number(),
    /** The post's images, in order (up to 4). The files are at /images/{id}. */
    images: z.array(ImageSummary),
    /** True when the post has its own images; false when it shares those of its material with the other posts. */
    ownImages: z.boolean(),
    // Where the post came from (the material it was written from). Included on reads.
    source: z
      .object({
        mode: z.string(),
        kind: z.string().nullable(),
        title: z.string().nullable(),
        url: z.string().nullable(),
        contextItemId: z.string().nullable(),
        instructions: z.string().nullable(),
        stance: z.enum(STANCES),
        research: z
          .object({
            summary: z.string(),
            sources: z.array(z.object({ url: z.string(), title: z.string() })),
            hints: z.array(z.object({ hint: z.string(), status: z.enum(["confirmed", "unconfirmed"]), source: z.string().optional() })),
          })
          .nullable(),
      })
      .nullable()
      .optional(),
  })
  .openapi("Draft");
type DraftRow = Awaited<ReturnType<typeof listDrafts>>[number];
export const toDraft = (d: DraftRow, images: ImageRow[] = []) => ({
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
  parts: d.parts ?? null,
  partsPosted: d.postedParts?.length ?? 0,
  images: images.map(toImageSummary),
  ownImages: d.ownImages || !d.briefId,
});

/** Drafts with their images (two extra queries for any number of posts). */
export async function draftsWithImages(db: Parameters<typeof imagesForDrafts>[0], orgId: string, rows: DraftRow[]) {
  const images = await imagesForDrafts(db, orgId, rows);
  return rows.map((d) => toDraft(d, images.get(d.id) ?? []));
}

contentApi.openapi(
  createRoute({
    method: "post",
    path: "/compose",
    tags: ["Content"],
    request: body(
      z.object({
        contextItemId: z.string(),
        /** "auto": the writer picks the style from the request. */
        mode: z.enum([...CONTENT_MODES, "auto"]),
        platforms: z.array(z.enum(PLATFORMS)).min(1).max(PLATFORMS.length),
        thread: z.boolean().optional(),
        /** The person's own instructions for these posts (followed). */
        instructions: z.string().trim().max(4000).optional(),
        /** "own": about my work. "other": my view on someone else's work. */
        stance: z.enum(STANCES).optional(),
        /** Look up facts on the web first (uses the monthly research allowance, then credits). */
        research: z.boolean().optional(),
      }),
    ),
    responses: {
      201: json(z.object({ briefId: z.string(), model: z.string(), angle: z.string(), drafts: z.array(DraftSchema) }), "Drafts created"),
      402: json(Err, "Out of posts and credits"),
      409: json(Err, "Voice not set up"),
      422: json(Err, "Research found nothing reliable"),
      503: json(Err, "AI or research unavailable"),
      ...errs,
    },
  }),
  async (c) => {
    if (denied(c, "content.write")) return c.json(forbidden("create posts"), 403);
    const input = c.req.valid("json");
    const providers = aiProviders(c.env);
    if (!providers.length) return c.json(apiError("ai_unavailable", "The writing engine isn't configured in this environment."), 503);
    try {
      const { orgId } = c.get("principal");
      const out = await compose(c.get("db"), providers, { orgId, ...input }, { research: researchProviders(c.env) });
      findImagesLater(c, c.get("db"), orgId, out.briefId);
      const sources = await draftSources(c.get("db"), orgId, [out.briefId]);
      return c.json({ briefId: out.briefId, model: out.model, angle: out.angle, drafts: out.drafts.map((d) => ({ ...toDraft(d), source: sources.get(out.briefId) ?? null })) }, 201);
    } catch (error) {
      if (error instanceof ComposeError) {
        const status =
          error.code === "quota_exceeded" ? 402 : error.code === "persona_required" ? 409 : error.code === "ai_unavailable" || error.code === "research_unavailable" ? 503 : error.code === "research_empty" ? 422 : error.code === "context_not_found" ? 404 : 400;
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
    request: { query: z.object({ status: z.enum(DRAFT_STATUSES).optional(), briefId: z.string().max(64).optional() }) },
    responses: { 200: json(z.object({ data: z.array(DraftSchema) })), ...errs },
  }),
  async (c) => {
    const { status, briefId } = c.req.valid("query");
    const { orgId } = c.get("principal");
    const rows = await listDrafts(c.get("db"), orgId, { ...(status ? { status } : {}), ...(briefId ? { briefId } : {}) });
    const sources = await draftSources(c.get("db"), orgId, rows.map((d) => d.briefId));
    const out = await draftsWithImages(c.get("db"), orgId, rows);
    return c.json({ data: out.map((d) => ({ ...d, source: d.briefId ? sources.get(d.briefId) ?? null : null })) }, 200);
  },
);

contentApi.openapi(
  createRoute({
    method: "get",
    path: "/drafts/{id}",
    tags: ["Content"],
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: json(z.object({ draft: DraftSchema })), ...errs },
  }),
  async (c) => {
    const { orgId } = c.get("principal");
    const d = await getDraft(c.get("db"), orgId, c.req.valid("param").id);
    if (!d) return c.json(apiError("not_found", "No such post in this workspace."), 404);
    const sources = await draftSources(c.get("db"), orgId, [d.briefId]);
    const [out] = await draftsWithImages(c.get("db"), orgId, [d]);
    return c.json({ draft: { ...out!, source: d.briefId ? sources.get(d.briefId) ?? null : null } }, 200);
  },
);

contentApi.openapi(
  createRoute({
    method: "patch",
    path: "/drafts/{id}",
    tags: ["Content"],
    request: { params: z.object({ id: z.string() }), ...body(z.object({ text: z.string().trim().min(1).max(30000).optional(), parts: z.array(z.string().max(30000)).min(1).max(20).optional(), status: z.enum(["draft", "approved", "discarded"]).optional() })) },
    responses: { 200: json(z.object({ draft: DraftSchema })), 409: json(Err, "Invalid state change"), ...errs },
  }),
  async (c) => {
    const patch = c.req.valid("json");
    if ((patch.text !== undefined || patch.parts !== undefined) && denied(c, "content.write")) return c.json(forbidden("edit posts"), 403);
    if (patch.status === "approved" && denied(c, "draft.approve")) return c.json(forbidden("approve posts"), 403);
    if (patch.status && patch.status !== "approved" && denied(c, "content.write")) return c.json(forbidden("change posts"), 403);
    const principal = c.get("principal");
    try {
      const updated = await updateDraft(c.get("db"), principal.orgId, c.req.valid("param").id, {
        ...(patch.text !== undefined ? { text: patch.text } : {}),
        ...(patch.parts !== undefined ? { parts: patch.parts } : {}),
        ...(patch.status ? { status: patch.status } : {}),
      });
      if (!updated) return c.json(apiError("not_found", "No such post in this workspace."), 404);
      if (patch.status === "approved") {
        // "Schedule when approved": the post goes to the next free slot, if switched on for its platform.
        if (can(principal.role, "publish") && (await autoScheduleApproved(c.get("db"), principal.orgId, [updated.id]))) {
          const now = await getDraft(c.get("db"), principal.orgId, updated.id);
          if (now) Object.assign(updated, now);
        }
        await recordAudit(c.get("db"), { orgId: principal.orgId, actorUserId: principal.kind === "user" ? principal.userId : null, actorApiKeyId: principal.kind === "api_key" ? principal.apiKeyId : null, action: "draft.approved", target: updated.id });
      }
      return c.json({ draft: (await draftsWithImages(c.get("db"), principal.orgId, [updated]))[0]! }, 200);
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
    const { plan, limits } = await getOrgLimits(c.get("db"), orgId);
    const usage = await getUsage(c.get("db"), orgId);
    return c.json(
      { plan, period: new Date().toISOString().slice(0, 7), posts: { used: usage.postsGenerated, limit: limits.posts }, videos: { used: usage.videosRendered, limit: limits.videos }, sources: { limit: limits.sources } },
      200,
    );
  },
);
