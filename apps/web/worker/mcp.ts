// MCP server (Streamable HTTP, stateless, JSON responses) so customers' AI agents can use Showrium.
// Auth: a workspace API key as a Bearer token (no cookies, so no cross-site risk).
// Tools can add material, write drafts, edit and approve them, and read ideas and usage.
// Publishing is deliberately not a tool: posts go out from the app or the REST API.
import { Hono } from "hono";
import { z } from "zod";
import { CONTENT_MODES, createDb, PLATFORMS, type Db } from "@nextrium/db";
import {
  addContextItems,
  compose,
  ComposeError,
  DraftStateError,
  getBalance,
  getOrgPlan,
  getUsage,
  listDrafts,
  listIdeas,
  PLAN_LIMITS,
  recordAudit,
  resolveApiKey,
  updateDraft,
} from "@nextrium/core";
import { aiProviders } from "./ai.js";
import type { Env } from "./env.js";

export const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

type Ctx = { db: Db; env: Env; orgId: string; apiKeyId: string };
type Tool<S extends z.ZodType> = { description: string; input: S; run: (ctx: Ctx, args: z.infer<S>) => Promise<unknown> };
const tool = <S extends z.ZodType>(t: Tool<S>) => t;

const TOOLS = {
  get_workspace: tool({
    description: "The workspace's plan, this month's usage and its credit balance.",
    input: z.object({}),
    run: async ({ db, orgId }) => {
      const plan = await getOrgPlan(db, orgId);
      const usage = await getUsage(db, orgId);
      return { plan, posts: { used: usage.postsGenerated, limit: PLAN_LIMITS[plan].posts }, videos: { used: usage.videosRendered, limit: PLAN_LIMITS[plan].videos }, credits: await getBalance(db, orgId) };
    },
  }),
  add_context: tool({
    description: "Add material to write about (notes, a changelog, an article text). Returns its id for compose_posts.",
    input: z.object({ text: z.string().min(20).max(20_000), title: z.string().max(300).optional() }),
    run: async ({ db, orgId }, a) => {
      const [row] = await addContextItems(db, orgId, "manual", [{ externalId: null, title: a.title ?? "", body: a.text, url: null }]);
      return { contextId: row!.id };
    },
  }),
  compose_posts: tool({
    description: "Write platform-native draft posts from a context item in the user's voice. Drafts need approval before publishing.",
    input: z.object({ context_id: z.string(), platforms: z.array(z.enum(PLATFORMS)).min(1).max(PLATFORMS.length), mode: z.enum(CONTENT_MODES).default("teach") }),
    run: async ({ db, env, orgId }, a) => {
      const providers = aiProviders(env);
      if (!providers.length) throw new ToolError("The writing engine isn't configured.");
      const out = await compose(db, providers, { orgId, contextItemId: a.context_id, mode: a.mode, platforms: a.platforms });
      return { angle: out.angle, drafts: out.drafts.map((d) => ({ id: d.id, platform: d.platform, text: d.text, issues: d.issues })) };
    },
  }),
  list_drafts: tool({
    description: "List posts by status (draft, approved, scheduled, published, failed, discarded).",
    input: z.object({ status: z.enum(["draft", "approved", "scheduled", "published", "failed", "discarded"]).default("draft") }),
    run: async ({ db, orgId }, a) => (await listDrafts(db, orgId, { status: a.status })).slice(0, 50).map((d) => ({ id: d.id, platform: d.platform, status: d.status, text: d.text, issues: d.issues, url: d.externalUrl })),
  }),
  update_draft: tool({
    description: "Edit a draft's text, or approve, discard or restore it.",
    input: z.object({ draft_id: z.string(), text: z.string().min(1).max(10_000).optional(), status: z.enum(["draft", "approved", "discarded"]).optional() }),
    run: async ({ db, orgId, apiKeyId }, a) => {
      const d = await updateDraft(db, orgId, a.draft_id, { ...(a.text !== undefined ? { text: a.text } : {}), ...(a.status ? { status: a.status } : {}) });
      if (!d) throw new ToolError("No such draft in this workspace.");
      if (a.status === "approved") await recordAudit(db, { orgId, actorApiKeyId: apiKeyId, action: "draft.approved", target: d.id, meta: { via: "mcp" } });
      return { id: d.id, status: d.status, text: d.text, issues: d.issues };
    },
  }),
  list_ideas: tool({
    description: "Post ideas Showrium found in the workspace's sources and audience comments, best first.",
    input: z.object({}),
    run: async ({ db, orgId }) => (await listIdeas(db, orgId)).slice(0, 20).map((i) => ({ id: i.id, reason: i.reason, contextId: i.contextItemId, summary: i.body.slice(0, 300) })),
  }),
};

class ToolError extends Error {}

type RpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };
const ok = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0" as const, id: id ?? null, result });
const fail = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } });

export async function handleRpc(ctx: Ctx, req: RpcRequest) {
  switch (req.method) {
    case "initialize": {
      const asked = String(req.params?.protocolVersion ?? "");
      return ok(req.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "showrium", version: "1.0.0" },
        instructions: "Showrium turns material into platform-native posts in the user's voice. Typical flow: add_context, then compose_posts, then update_draft to approve. Posts are published from the Showrium app.",
      });
    }
    case "ping":
      return ok(req.id, {});
    case "tools/list":
      return ok(req.id, { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: z.toJSONSchema(t.input, { io: "input" }) })) });
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const t = TOOLS[name as keyof typeof TOOLS] as Tool<z.ZodType> | undefined;
      if (!t) return fail(req.id, -32602, `Unknown tool: ${name}`);
      const parsed = t.input.safeParse(req.params?.arguments ?? {});
      if (!parsed.success) return ok(req.id, { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` }], isError: true });
      try {
        const result = await t.run(ctx, parsed.data);
        return ok(req.id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: Array.isArray(result) ? { items: result } : result });
      } catch (error) {
        // Known, user-safe errors are returned to the agent; anything else is logged and hidden.
        if (error instanceof ToolError || error instanceof ComposeError || error instanceof DraftStateError) {
          return ok(req.id, { content: [{ type: "text", text: error.message }], isError: true });
        }
        console.error("mcp tool failed", name, error);
        return ok(req.id, { content: [{ type: "text", text: "Something went wrong on our side." }], isError: true });
      }
    }
    default:
      return fail(req.id, -32601, `Method not found: ${req.method}`);
  }
}

export const mcp = new Hono<{ Bindings: Env }>();

mcp.post("/", async (c) => {
  const auth = c.req.header("Authorization");
  const db = createDb(c.env.DB);
  const key = auth?.startsWith("Bearer ") ? await resolveApiKey(db, auth.slice(7).trim()) : null;
  if (!key) {
    c.header("WWW-Authenticate", 'Bearer realm="showrium", error="invalid_token"');
    return c.json(fail(null, -32001, "Send a Showrium API key as 'Authorization: Bearer <key>'."), 401);
  }
  if (Number(c.req.header("Content-Length") ?? 0) > 256 * 1024) return c.json(fail(null, -32600, "Request too large."), 413);
  let req: RpcRequest;
  try {
    req = (await c.req.json()) as RpcRequest;
  } catch {
    return c.json(fail(null, -32700, "Parse error."), 400);
  }
  if (!req || typeof req !== "object" || Array.isArray(req) || req.jsonrpc !== "2.0" || typeof req.method !== "string") return c.json(fail(null, -32600, "Invalid request."), 400);
  // Notifications (no id) get no body.
  if (req.id === undefined) return c.body(null, 202);
  return c.json(await handleRpc({ db, env: c.env, orgId: key.orgId, apiKeyId: key.id }, req), 200);
});

// No server-initiated stream and no sessions: GET and DELETE aren't supported.
mcp.on(["GET", "DELETE"], "/", (c) => c.body(null, 405, { Allow: "POST" }));
