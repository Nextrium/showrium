// Phase 5 API: ideas, autopilot, batch approval, engagement, insights and analytics.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AUTOPILOT_LEVELS, CONTENT_MODES, PLATFORMS } from "@nextrium/db";
import {
  addManualEngagement,
  AutopilotError,
  can,
  ComposeError,
  composeIdea,
  dismissIdea,
  DraftStateError,
  EngagementError,
  getAnalytics,
  getDraft,
  getAutopilot,
  getSummary,
  ideaFromTheme,
  IdeaError,
  InsightError,
  latestInsight,
  listEngagement,
  listIdeas,
  ideaCounts,
  getIdea,
  restoreIdea,
  recordAudit,
  refreshInsights,
  refreshPostEngagement,
  saveAutopilot,
  saveLegacyAutopilot,
  autoScheduleApproved,
  updateDraft,
  type Permission,
} from "@nextrium/core";
import { PlatformError } from "@nextrium/platforms";
import { aiProviders } from "./ai.js";
import { toDraft } from "./content-api.js";
import { apiError, requirePrincipal, type AppEnv, type Principal } from "./principal.js";

export const autonomyApi = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) return c.json(apiError("invalid_request", result.error.issues.map((i) => i.message).join("; ")), 400);
  },
});
for (const path of ["/ideas", "/ideas/*", "/autopilot", "/engagement", "/insights", "/insights/*", "/analytics", "/drafts/bulk-approve", "/drafts/:id/engagement", "/drafts/:id/engagement/*"]) {
  autonomyApi.use(path, requirePrincipal);
}

const Err = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const json = <T extends z.ZodType>(schema: T, description = "OK") => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { required: true, content: { "application/json": { schema } } } });
const errs = {
  400: json(Err, "Invalid"),
  401: json(Err, "Not signed in"),
  403: json(Err, "Not allowed"),
  404: json(Err, "Not found"),
  409: json(Err, "Conflict"),
};
const forbidden = (what: string) => apiError("forbidden", `Your role can't ${what} in this workspace.`);
const denied = (p: Principal, permission: Permission) => !can(p.role, permission);
const actor = (p: Principal) => ({ actorUserId: p.kind === "user" ? p.userId : null, actorApiKeyId: p.kind === "api_key" ? p.apiKeyId : null });

// --- Ideas -----------------------------------------------------------------------------

const IdeaSchema = z
  .object({ id: z.string(), reason: z.string(), score: z.number(), status: z.enum(["new", "drafted", "dismissed"]), title: z.string(), kind: z.string(), body: z.string(), url: z.string().nullable(), createdAt: z.string() })
  .openapi("Idea");
const Counts = z.object({ new: z.number(), drafted: z.number(), dismissed: z.number() });

autonomyApi.openapi(
  createRoute({ method: "get", path: "/ideas", tags: ["Autonomy"], request: { query: z.object({ status: z.enum(["new", "drafted", "dismissed"]).default("new") }) }, responses: { 200: json(z.object({ data: z.array(IdeaSchema), counts: Counts })), ...errs } }),
  async (c) => {
    const { orgId } = c.get("principal");
    const [rows, counts] = await Promise.all([listIdeas(c.get("db"), orgId, c.req.valid("query").status), ideaCounts(c.get("db"), orgId)]);
    return c.json({ data: rows.map((r) => ({ id: r.id, reason: r.reason, score: r.score, status: r.status, title: r.title, kind: r.kind, body: r.body, url: r.url, createdAt: r.createdAt.toISOString() })), counts }, 200);
  },
);

autonomyApi.openapi(
  createRoute({ method: "get", path: "/ideas/{id}", tags: ["Autonomy"], request: { params: z.object({ id: z.string() }) }, responses: { 200: json(z.object({ idea: IdeaSchema.extend({ briefId: z.string().nullable() }) })), ...errs } }),
  async (c) => {
    const r = await getIdea(c.get("db"), c.get("principal").orgId, c.req.valid("param").id);
    if (!r) return c.json(apiError("not_found", "No such idea in this workspace."), 404);
    return c.json({ idea: { id: r.id, reason: r.reason, score: r.score, status: r.status, title: r.title, kind: r.kind, body: r.body, url: r.url, createdAt: r.createdAt.toISOString(), briefId: r.briefId } }, 200);
  },
);

autonomyApi.openapi(
  createRoute({ method: "post", path: "/ideas/{id}/restore", tags: ["Autonomy"], request: { params: z.object({ id: z.string() }) }, responses: { 204: { description: "Restored" }, ...errs } }),
  async (c) => {
    if (denied(c.get("principal"), "content.write")) return c.json(forbidden("restore ideas"), 403);
    if (!(await restoreIdea(c.get("db"), c.get("principal").orgId, c.req.valid("param").id))) return c.json(apiError("not_found", "No such dismissed idea in this workspace."), 404);
    return c.body(null, 204);
  },
);

autonomyApi.openapi(
  createRoute({ method: "post", path: "/ideas/{id}/dismiss", tags: ["Autonomy"], request: { params: z.object({ id: z.string() }) }, responses: { 204: { description: "Dismissed" }, ...errs } }),
  async (c) => {
    if (denied(c.get("principal"), "content.write")) return c.json(forbidden("dismiss ideas"), 403);
    if (!(await dismissIdea(c.get("db"), c.get("principal").orgId, c.req.valid("param").id))) return c.json(apiError("not_found", "No such new idea in this workspace."), 404);
    return c.body(null, 204);
  },
);

autonomyApi.openapi(
  createRoute({
    method: "post",
    path: "/ideas/{id}/compose",
    tags: ["Autonomy"],
    request: { params: z.object({ id: z.string() }), ...body(z.object({ mode: z.enum(CONTENT_MODES), platforms: z.array(z.enum(PLATFORMS)).min(1).max(PLATFORMS.length) })) },
    responses: { 201: json(z.object({ briefId: z.string(), drafts: z.array(z.any()) }), "Drafts created"), 402: json(Err, "Out of posts"), 503: json(Err, "AI unavailable"), ...errs },
  }),
  async (c) => {
    const p = c.get("principal");
    if (denied(p, "content.write")) return c.json(forbidden("create posts"), 403);
    const providers = aiProviders(c.env);
    if (!providers.length) return c.json(apiError("ai_unavailable", "The writing engine isn't configured in this environment."), 503);
    try {
      const out = await composeIdea(c.get("db"), providers, { orgId: p.orgId, ideaId: c.req.valid("param").id, ...c.req.valid("json") });
      return c.json({ briefId: out.briefId, drafts: out.drafts.map(toDraft) }, 201);
    } catch (error) {
      if (error instanceof IdeaError) return c.json(apiError(error.code, error.message), error.code === "not_found" ? 404 : 409);
      if (error instanceof ComposeError) {
        const status = error.code === "quota_exceeded" ? 402 : error.code === "ai_unavailable" ? 503 : error.code === "context_not_found" ? 404 : 409;
        return c.json(apiError(error.code, error.message), status);
      }
      throw error;
    }
  },
);

// --- Autopilot --------------------------------------------------------------------------

const Rule = z.object({ write: z.boolean(), schedule: z.boolean(), approve: z.boolean() });
const AutomationInput = z
  .object({
    findIdeas: z.boolean(),
    rules: z.partialRecord(z.enum(PLATFORMS), Rule),
    mix: z.partialRecord(z.enum(CONTENT_MODES), z.number().int().min(0).max(14)),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    publishHourUtc: z.number().int().min(0).max(23),
  })
  .openapi("Automation");
// The earlier single-level shape, still accepted.
const LegacyInput = z
  .object({
    level: z.enum(AUTOPILOT_LEVELS),
    mode: z.enum(CONTENT_MODES),
    platforms: z.array(z.enum(PLATFORMS)).max(PLATFORMS.length),
    postsPerWeek: z.number().int().min(1).max(14),
    publishHourUtc: z.number().int().min(0).max(23),
  })
  .openapi("AutopilotLegacy");
const AutomationOut = AutomationInput.extend({
  level: z.enum(AUTOPILOT_LEVELS),
  mode: z.enum(CONTENT_MODES),
  platforms: z.array(z.enum(PLATFORMS)),
  postsPerWeek: z.number(),
  lastRunAt: z.string().nullable(),
}).openapi("AutomationSettings");
type Saved = Awaited<ReturnType<typeof getAutopilot>>;
const out = (s: Saved) => ({ ...s, lastRunAt: s.lastRunAt?.toISOString() ?? null });

autonomyApi.openapi(
  createRoute({ method: "get", path: "/autopilot", tags: ["Autonomy"], responses: { 200: json(AutomationOut), ...errs } }),
  async (c) => c.json(out(await getAutopilot(c.get("db"), c.get("principal").orgId)), 200),
);

autonomyApi.openapi(
  createRoute({ method: "put", path: "/autopilot", tags: ["Autonomy"], request: body(z.union([AutomationInput, LegacyInput])), responses: { 200: json(AutomationOut), 402: json(Err, "Plan required"), ...errs } }),
  async (c) => {
    const p = c.get("principal");
    // Automation can publish without a per-post approval, so only owners and admins may change it.
    if (denied(p, "workspace.manage")) return c.json(forbidden("change automation"), 403);
    try {
      const input = c.req.valid("json");
      const s = "rules" in input ? await saveAutopilot(c.get("db"), p.orgId, input) : await saveLegacyAutopilot(c.get("db"), p.orgId, input);
      await recordAudit(c.get("db"), { orgId: p.orgId, ...actor(p), action: "autopilot.updated", meta: { level: s.level, rules: s.rules, mix: s.mix, findIdeas: s.findIdeas } });
      return c.json(out(s), 200);
    } catch (error) {
      if (error instanceof AutopilotError) return error.code === "plan_required" ? c.json(apiError("plan_required", error.message), 402) : c.json(apiError("invalid_autopilot", error.message), 409);
      throw error;
    }
  },
);

// --- Batch approval ----------------------------------------------------------------------

autonomyApi.openapi(
  createRoute({
    method: "post",
    path: "/drafts/bulk-approve",
    tags: ["Content"],
    request: body(z.object({ ids: z.array(z.string()).min(1).max(50) })),
    responses: { 200: json(z.object({ approved: z.array(z.string()), skipped: z.array(z.object({ id: z.string(), reason: z.string() })) })), ...errs },
  }),
  async (c) => {
    const p = c.get("principal");
    if (denied(p, "draft.approve")) return c.json(forbidden("approve posts"), 403);
    const approved: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of [...new Set(c.req.valid("json").ids)]) {
      // One-tap approval is only for clean posts; anything with a warning gets a look on its own.
      const current = await getDraft(c.get("db"), p.orgId, id);
      if (current?.issues.length) {
        skipped.push({ id, reason: "Has warnings to check first." });
        continue;
      }
      try {
        const d = await updateDraft(c.get("db"), p.orgId, id, { status: "approved" });
        if (!d) skipped.push({ id, reason: "Not found." });
        else {
          approved.push(id);
          await recordAudit(c.get("db"), { orgId: p.orgId, ...actor(p), action: "draft.approved", target: id, meta: { bulk: true } });
        }
      } catch (error) {
        if (!(error instanceof DraftStateError)) throw error;
        skipped.push({ id, reason: error.message });
      }
    }
    // "Schedule when approved" (per platform, in Automation).
    if (!denied(p, "publish")) await autoScheduleApproved(c.get("db"), p.orgId, approved);
    return c.json({ approved, skipped }, 200);
  },
);

// --- Engagement -------------------------------------------------------------------------

function engagementStatus(e: EngagementError) {
  return e.code === "not_found" ? 404 : e.code === "too_soon" ? 429 : 409;
}

autonomyApi.openapi(
  createRoute({
    method: "get",
    path: "/engagement",
    tags: ["Learning"],
    responses: { 200: json(z.object({ data: z.array(z.object({ id: z.string(), draftId: z.string(), platform: z.string(), origin: z.enum(["api", "manual"]), author: z.string(), text: z.string(), createdAt: z.string() })) })), ...errs },
  }),
  async (c) => {
    const rows = await listEngagement(c.get("db"), c.get("principal").orgId);
    return c.json({ data: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) }, 200);
  },
);

autonomyApi.openapi(
  createRoute({
    method: "post",
    path: "/drafts/{id}/engagement",
    tags: ["Learning"],
    request: {
      params: z.object({ id: z.string() }),
      ...body(
        z.object({
          comments: z.array(z.string().max(2000)).max(50).default([]),
          likes: z.number().int().min(0).max(100_000_000).optional(),
          replies: z.number().int().min(0).max(100_000_000).optional(),
          reposts: z.number().int().min(0).max(100_000_000).optional(),
        }),
      ),
    },
    responses: { 201: json(z.object({ added: z.number() }), "Saved"), ...errs },
  }),
  async (c) => {
    const p = c.get("principal");
    if (denied(p, "content.write")) return c.json(forbidden("add comments"), 403);
    try {
      return c.json(await addManualEngagement(c.get("db"), p.orgId, c.req.valid("param").id, c.req.valid("json")), 201);
    } catch (error) {
      if (error instanceof EngagementError) return c.json(apiError(error.code, error.message), engagementStatus(error) as 404);
      throw error;
    }
  },
);

autonomyApi.openapi(
  createRoute({
    method: "post",
    path: "/drafts/{id}/engagement/refresh",
    tags: ["Learning"],
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: json(z.object({ likes: z.number(), replies: z.number(), reposts: z.number(), added: z.number() })), 429: json(Err, "Too soon"), 502: json(Err, "Platform error"), ...errs },
  }),
  async (c) => {
    const p = c.get("principal");
    if (denied(p, "content.write")) return c.json(forbidden("check replies"), 403);
    try {
      return c.json(await refreshPostEngagement(c.get("db"), p.orgId, c.req.valid("param").id), 200);
    } catch (error) {
      if (error instanceof EngagementError) return c.json(apiError(error.code, error.message), engagementStatus(error) as 404);
      if (error instanceof PlatformError) return c.json(apiError("platform_error", error.message), 502);
      throw error;
    }
  },
);

// --- Insights ---------------------------------------------------------------------------

const ThemeSchema = z.object({ label: z.string(), kind: z.enum(["question", "objection", "praise", "request", "other"]), count: z.number(), examples: z.array(z.string()), suggestion: z.string() });
const InsightOut = z.object({ id: z.string(), themes: z.array(ThemeSchema), basedOn: z.number(), createdAt: z.string() }).nullable().openapi("Insight");
type InsightRow = NonNullable<Awaited<ReturnType<typeof latestInsight>>>;
const toInsight = (r: InsightRow | null) => (r ? { id: r.id, themes: r.themes, basedOn: r.basedOn, createdAt: r.createdAt.toISOString() } : null);

function insightStatus(e: InsightError) {
  return e.code === "too_soon" ? 429 : e.code === "ai_unavailable" ? 503 : e.code === "not_found" ? 404 : e.code === "plan_required" ? 402 : 409;
}

autonomyApi.openapi(
  createRoute({ method: "get", path: "/insights", tags: ["Learning"], responses: { 200: json(z.object({ insight: InsightOut })), ...errs } }),
  async (c) => c.json({ insight: toInsight(await latestInsight(c.get("db"), c.get("principal").orgId)) }, 200),
);

autonomyApi.openapi(
  createRoute({ method: "post", path: "/insights/refresh", tags: ["Learning"], responses: { 201: json(z.object({ insight: InsightOut }), "Refreshed"), 402: json(Err, "Plan required"), 429: json(Err, "Too soon"), 503: json(Err, "AI unavailable"), ...errs } }),
  async (c) => {
    const p = c.get("principal");
    if (denied(p, "content.write")) return c.json(forbidden("refresh insights"), 403);
    try {
      return c.json({ insight: toInsight(await refreshInsights(c.get("db"), aiProviders(c.env), p.orgId)) }, 201);
    } catch (error) {
      if (error instanceof InsightError) return c.json(apiError(error.code, error.message), insightStatus(error) as 404);
      throw error;
    }
  },
);

autonomyApi.openapi(
  createRoute({
    method: "post",
    path: "/insights/{id}/themes/{index}/idea",
    tags: ["Learning"],
    request: { params: z.object({ id: z.string(), index: z.coerce.number().int().min(0).max(5) }) },
    responses: { 201: json(z.object({ ideaId: z.string() }), "Idea created"), ...errs },
  }),
  async (c) => {
    const p = c.get("principal");
    if (denied(p, "content.write")) return c.json(forbidden("create ideas"), 403);
    const { id, index } = c.req.valid("param");
    try {
      return c.json({ ideaId: await ideaFromTheme(c.get("db"), p.orgId, id, index) }, 201);
    } catch (error) {
      if (error instanceof InsightError) return c.json(apiError(error.code, error.message), insightStatus(error) as 404);
      throw error;
    }
  },
);

// --- Analytics --------------------------------------------------------------------------

autonomyApi.openapi(
  createRoute({
    method: "get",
    path: "/analytics",
    tags: ["Learning"],
    responses: {
      200: json(
        z.object({
          statuses: z.record(z.string(), z.number()),
          platforms: z.array(z.object({ platform: z.string(), posts: z.number(), likes: z.number(), replies: z.number(), reposts: z.number() })),
          modes: z.array(z.object({ mode: z.string(), posts: z.number(), avgScore: z.number() })),
          perWeek: z.array(z.number()),
          top: z.array(z.object({ id: z.string(), platform: z.string(), text: z.string(), url: z.string().nullable(), score: z.number() })),
          aiCostUsdThisMonth: z.number(),
          newIdeas: z.number(),
        }),
      ),
      ...errs,
    },
  }),
  async (c) => c.json(await getAnalytics(c.get("db"), c.get("principal").orgId), 200),
);

// --- Summary (navigation badges) -------------------------------------------------------------

autonomyApi.use("/summary", requirePrincipal);
autonomyApi.openapi(
  createRoute({ method: "get", path: "/summary", tags: ["Autonomy"], responses: { 200: json(z.object({ drafts: z.number(), ideas: z.number() })), ...errs } }),
  async (c) => c.json(await getSummary(c.get("db"), c.get("principal").orgId), 200),
);
