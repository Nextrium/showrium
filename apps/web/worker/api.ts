// Public REST API, version 1. The web app uses exactly this API.
// OpenAPI document: GET /api/v1/openapi.json
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createDb } from "@nextrium/db";
import {
  ApiKeyLimitError,
  createApiKey,
  getBalance,
  getOrg,
  listApiKeys,
  listCreditTxns,
  recordAudit,
  revokeApiKey,
} from "@nextrium/core";
import { joinWaitlist } from "@nextrium/core";
import { authProviders, signupMode } from "./env.js";
import { apiError, canManageKeys, requirePrincipal, type AppEnv } from "./principal.js";

const ErrorSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .openapi("Error");

const errors = {
  401: { description: "Not signed in, or the API key is invalid", content: { "application/json": { schema: ErrorSchema } } },
  403: { description: "Not allowed", content: { "application/json": { schema: ErrorSchema } } },
};

export const api = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) return c.json(apiError("invalid_request", result.error.issues.map((i) => i.message).join("; ")), 400);
  },
});

// --- Public -----------------------------------------------------------------

api.openapi(
  createRoute({
    method: "get",
    path: "/health",
    tags: ["System"],
    responses: {
      200: { description: "Service is up", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
    },
  }),
  (c) => c.json({ ok: true }, 200),
);

api.openapi(
  createRoute({
    method: "get",
    path: "/config",
    tags: ["System"],
    responses: {
      200: {
        description: "Which sign-in methods are available",
        content: {
          "application/json": {
            schema: z.object({
              auth: z.object({ password: z.boolean(), github: z.boolean(), google: z.boolean() }),
              signupMode: z.enum(["waitlist", "allowlist"]),
            }),
          },
        },
      },
    },
  }),
  (c) => c.json({ auth: authProviders(c.env), signupMode: signupMode(c.env) }, 200),
);

api.openapi(
  createRoute({
    method: "post",
    path: "/waitlist",
    tags: ["System"],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              email: z.email().max(254),
              // Honeypot: hidden in the form. People leave it empty; bots fill it in.
              website: z.string().max(200).optional(),
            }),
          },
        },
      },
    },
    responses: {
      202: {
        description: "Received. The same response is returned whether or not the email was already on the list.",
        content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
      },
      400: { description: "Invalid email", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { email, website } = c.req.valid("json");
    if (!website) await joinWaitlist(createDb(c.env.DB), email);
    return c.json({ ok: true as const }, 202);
  },
);

// --- Authenticated ----------------------------------------------------------

api.use("/me", requirePrincipal);
api.use("/credits/*", requirePrincipal);
api.use("/api-keys/*", requirePrincipal);
api.use("/api-keys", requirePrincipal);

const OrgSchema = z
  .object({ id: z.string(), name: z.string(), slug: z.string(), plan: z.string() })
  .openapi("Workspace");

api.openapi(
  createRoute({
    method: "get",
    path: "/me",
    tags: ["Account"],
    responses: {
      200: {
        description: "The caller and their current workspace",
        content: {
          "application/json": {
            schema: z.object({
              principal: z.object({ kind: z.enum(["user", "api_key"]), role: z.string() }),
              workspace: OrgSchema,
            }),
          },
        },
      },
      ...errors,
    },
  }),
  async (c) => {
    const principal = c.get("principal");
    const workspace = await getOrg(c.get("db"), principal.orgId);
    if (!workspace) return c.json(apiError("no_workspace", "Workspace not found."), 403);
    return c.json({ principal: { kind: principal.kind, role: principal.role }, workspace }, 200);
  },
);

api.openapi(
  createRoute({
    method: "get",
    path: "/credits",
    tags: ["Credits"],
    responses: {
      200: {
        description: "Credit balance (1 credit = $0.01) and recent transactions",
        content: {
          "application/json": {
            schema: z.object({
              balance: z.number().int(),
              transactions: z.array(
                z.object({
                  id: z.string(),
                  kind: z.string(),
                  description: z.string(),
                  amount: z.number().int(),
                  createdAt: z.string(),
                }),
              ),
            }),
          },
        },
      },
      ...errors,
    },
  }),
  async (c) => {
    const { orgId } = c.get("principal");
    const db = c.get("db");
    const [balance, txns] = await Promise.all([getBalance(db, orgId), listCreditTxns(db, orgId)]);
    return c.json(
      { balance, transactions: txns.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })) },
      200,
    );
  },
);

const ApiKeySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    prefix: z.string(),
    lastUsedAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("ApiKey");

api.openapi(
  createRoute({
    method: "get",
    path: "/api-keys",
    tags: ["API keys"],
    responses: {
      200: { description: "API keys in this workspace", content: { "application/json": { schema: z.object({ data: z.array(ApiKeySchema) }) } } },
      ...errors,
    },
  }),
  async (c) => {
    const keys = await listApiKeys(c.get("db"), c.get("principal").orgId);
    return c.json(
      {
        data: keys.map((k) => ({
          ...k,
          lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
          revokedAt: k.revokedAt?.toISOString() ?? null,
          createdAt: k.createdAt.toISOString(),
        })),
      },
      200,
    );
  },
);

api.openapi(
  createRoute({
    method: "post",
    path: "/api-keys",
    tags: ["API keys"],
    request: {
      body: {
        content: { "application/json": { schema: z.object({ name: z.string().trim().min(1).max(60) }) } },
        required: true,
      },
    },
    responses: {
      201: {
        description: "The new key. `key` is shown only once; store it safely.",
        content: {
          "application/json": {
            schema: z.object({ id: z.string(), name: z.string(), prefix: z.string(), key: z.string() }),
          },
        },
      },
      409: { description: "Too many active keys", content: { "application/json": { schema: ErrorSchema } } },
      ...errors,
    },
  }),
  async (c) => {
    const principal = c.get("principal");
    if (!canManageKeys(principal)) {
      return c.json(apiError("forbidden", "Only workspace owners and admins can create API keys, from the app."), 403);
    }
    let created;
    try {
      created = await createApiKey(c.get("db"), {
        orgId: principal.orgId,
        name: c.req.valid("json").name,
        createdByUserId: principal.kind === "user" ? principal.userId : null,
      });
    } catch (error) {
      if (error instanceof ApiKeyLimitError) return c.json(apiError("key_limit", error.message), 409);
      throw error;
    }
    await recordAudit(c.get("db"), {
      orgId: principal.orgId,
      actorUserId: principal.kind === "user" ? principal.userId : null,
      action: "api_key.created",
      target: created.id,
    });
    return c.json(created, 201);
  },
);

api.openapi(
  createRoute({
    method: "delete",
    path: "/api-keys/{id}",
    tags: ["API keys"],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: "Revoked" },
      404: { description: "No active key with this ID in the workspace", content: { "application/json": { schema: ErrorSchema } } },
      ...errors,
    },
  }),
  async (c) => {
    const principal = c.get("principal");
    if (!canManageKeys(principal)) {
      return c.json(apiError("forbidden", "Only workspace owners and admins can revoke API keys, from the app."), 403);
    }
    const { id } = c.req.valid("param");
    const revoked = await revokeApiKey(c.get("db"), principal.orgId, id);
    if (!revoked) return c.json(apiError("not_found", "No active API key with that ID in this workspace."), 404);
    await recordAudit(c.get("db"), {
      orgId: principal.orgId,
      actorUserId: principal.kind === "user" ? principal.userId : null,
      action: "api_key.revoked",
      target: id,
    });
    return c.body(null, 204);
  },
);

api.doc31("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Showrium API",
    version: "1.0.0",
    description: "One API for Showrium: workspaces, credits and API keys (more resources arrive each phase).",
  },
  servers: [{ url: "/api/v1" }],
});
