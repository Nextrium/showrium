// Phase 3 API: connected accounts (OAuth / app passwords) and publishing.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { CONNECTION_PLATFORMS, type ConnectionPlatform, type Db } from "@nextrium/db";
import {
  assertSafeUrl,
  can,
  consumeOAuthState,
  createOAuthState,
  EncryptionUnavailableError,
  getDraft,
  importTokenKey,
  listConnections,
  markPublishedManually,
  mastodonClient,
  publishDraft,
  PublishError,
  removeConnection,
  resolveMembership,
  saveConnection,
  scheduleDraft,
  setDraftConnection,
  UnsafeUrlError,
  type PublishDeps,
} from "@nextrium/core";
import { bluesky, intentUrl, linkedin, mastodon, PlatformError, tiktok, x, type OAuthConfig } from "@nextrium/platforms";
import type { Env } from "./env.js";
import { apiError, requirePrincipal, type AppEnv } from "./principal.js";

export const connectionsApi = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) return c.json(apiError("invalid_request", result.error.issues.map((i) => i.message).join("; ")), 400);
  },
});
connectionsApi.use("/connections", requirePrincipal);
connectionsApi.use("/connections/*", requirePrincipal);
connectionsApi.use("/drafts/:id/publish", requirePrincipal);
connectionsApi.use("/drafts/:id/schedule", requirePrincipal);
connectionsApi.use("/drafts/:id/mark-published", requirePrincipal);
connectionsApi.use("/drafts/:id/intent", requirePrincipal);

const Err = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const errs = {
  400: { description: "Invalid", content: { "application/json": { schema: Err } } },
  401: { description: "Not signed in", content: { "application/json": { schema: Err } } },
  403: { description: "Not allowed", content: { "application/json": { schema: Err } } },
  404: { description: "Not found", content: { "application/json": { schema: Err } } },
  503: { description: "Not configured", content: { "application/json": { schema: Err } } },
};
const json = <T extends z.ZodType>(schema: T, description = "OK") => ({ description, content: { "application/json": { schema } } });

function callbackUrl(env: Env, platform: string) {
  return `${new URL(env.BETTER_AUTH_URL).origin}/api/v1/connections/${platform}/callback`;
}

export function platformConfigs(env: Env): PublishDeps["configs"] {
  const cfg = (id?: string, secret?: string, platform?: string): OAuthConfig | undefined =>
    id && secret && platform ? { clientId: id, clientSecret: secret, redirectUri: callbackUrl(env, platform) } : undefined;
  const sandbox = env.TIKTOK_USE_SANDBOX === "true";
  return {
    x: cfg(env.X_CLIENT_ID, env.X_CLIENT_SECRET, "x"),
    linkedin: cfg(env.LINKEDIN_CLIENT_ID, env.LINKEDIN_CLIENT_SECRET, "linkedin"),
    tiktok: sandbox ? cfg(env.TIKTOK_SANDBOX_CLIENT_KEY, env.TIKTOK_SANDBOX_CLIENT_SECRET, "tiktok") : cfg(env.TIKTOK_CLIENT_KEY, env.TIKTOK_CLIENT_SECRET, "tiktok"),
    mastodonRedirectUri: callbackUrl(env, "mastodon"),
  };
}

export async function publishDeps(env: Env, db: Db): Promise<PublishDeps> {
  return { db, key: await importTokenKey(env.TOKEN_ENCRYPTION_KEY), configs: platformConfigs(env) };
}

const notConfigured = () => apiError("not_configured", "Connecting accounts isn't set up in this environment yet.");

// --- List and remove ----------------------------------------------------------------

const ConnectionSchema = z
  .object({ id: z.string(), platform: z.enum(CONNECTION_PLATFORMS), handle: z.string(), status: z.enum(["active", "needs_reconnect"]), createdAt: z.string() })
  .openapi("Connection");

connectionsApi.openapi(
  createRoute({
    method: "get",
    path: "/connections",
    tags: ["Accounts"],
    responses: { 200: json(z.object({ data: z.array(ConnectionSchema), available: z.array(z.enum(CONNECTION_PLATFORMS)) })), ...errs },
  }),
  async (c) => {
    const rows = await listConnections(c.get("db"), c.get("principal").orgId);
    const cfg = platformConfigs(c.env);
    const encryption = Boolean(c.env.TOKEN_ENCRYPTION_KEY);
    const available = encryption
      ? CONNECTION_PLATFORMS.filter((p) => (p === "bluesky" || p === "mastodon" ? true : Boolean(cfg[p as "x" | "linkedin" | "tiktok"])))
      : [];
    return c.json({ data: rows.map((r) => ({ id: r.id, platform: r.platform, handle: r.handle, status: r.status, createdAt: r.createdAt.toISOString() })), available }, 200);
  },
);

connectionsApi.openapi(
  createRoute({ method: "delete", path: "/connections/{id}", tags: ["Accounts"], request: { params: z.object({ id: z.string() }) }, responses: { 204: { description: "Disconnected" }, ...errs } }),
  async (c) => {
    const p = c.get("principal");
    if (!can(p.role, "workspace.manage")) return c.json(apiError("forbidden", "Only owners and admins can disconnect accounts."), 403);
    const ok = await removeConnection(c.get("db"), p.orgId, c.req.valid("param").id, p.kind === "user" ? p.userId : null);
    return ok ? c.body(null, 204) : c.json(apiError("not_found", "No such account in this workspace."), 404);
  },
);

// --- OAuth start ----------------------------------------------------------------------

connectionsApi.openapi(
  createRoute({
    method: "post",
    path: "/connections/{platform}/start",
    tags: ["Accounts"],
    request: {
      params: z.object({ platform: z.enum(["x", "linkedin", "tiktok", "mastodon"]) }),
      body: { required: false, content: { "application/json": { schema: z.object({ instance: z.string().trim().toLowerCase().max(253).optional() }) } } },
    },
    responses: { 200: json(z.object({ authorizeUrl: z.string() })), ...errs },
  }),
  async (c) => {
    const p = c.get("principal");
    if (p.kind !== "user") return c.json(apiError("forbidden", "Connect accounts from the Showrium app."), 403);
    if (!can(p.role, "workspace.manage")) return c.json(apiError("forbidden", "Only owners and admins can connect accounts."), 403);
    const { platform } = c.req.valid("param");
    let deps: PublishDeps;
    try {
      deps = await publishDeps(c.env, c.get("db"));
    } catch (error) {
      if (error instanceof EncryptionUnavailableError) return c.json(notConfigured(), 503);
      throw error;
    }
    if (platform === "mastodon") {
      const instance = (await c.req.json().catch(() => ({}))).instance as string | undefined;
      if (!instance) return c.json(apiError("invalid_request", "Enter your Mastodon server, e.g. mastodon.social."), 400);
      try {
        assertSafeUrl(`https://${instance}/`);
      } catch (error) {
        return c.json(apiError("unsafe_url", error instanceof UnsafeUrlError ? error.message : "Invalid server."), 400);
      }
      try {
        const client = await mastodonClient(deps, instance);
        const { state, challenge } = await createOAuthState(c.get("db"), { orgId: p.orgId, userId: p.userId, platform, meta: { instance } });
        return c.json({ authorizeUrl: mastodon.authorizeUrl(instance, client, state, challenge) }, 200);
      } catch (error) {
        return c.json(apiError("platform_error", error instanceof PlatformError ? `Couldn't reach ${instance}. Check the server name.` : "Couldn't start the connection."), 400);
      }
    }
    const cfg = deps.configs[platform];
    if (!cfg) return c.json(notConfigured(), 503);
    const { state, challenge } = await createOAuthState(c.get("db"), { orgId: p.orgId, userId: p.userId, platform });
    const authorizeUrl = platform === "x" ? x.authorizeUrl(cfg, state, challenge) : platform === "linkedin" ? linkedin.authorizeUrl(cfg, state) : tiktok.authorizeUrl(cfg, state, challenge);
    return c.json({ authorizeUrl }, 200);
  },
);

// --- OAuth callback (browser navigation from the platform) -----------------------------------

connectionsApi.get("/connections/:platform/callback", async (c) => {
  const done = (query: string) => c.redirect(`/app/accounts?${query}`, 302);
  const platform = c.req.param("platform") as ConnectionPlatform;
  const state = c.req.query("state");
  const code = c.req.query("code");
  if (c.req.query("error") || !state || !code) return done("error=cancelled");
  const row = await consumeOAuthState(c.get("db"), state);
  const p = c.get("principal");
  // The state must exist, be unexpired, match this platform, and belong to the signed-in user.
  if (!row || row.platform !== platform || p.kind !== "user" || row.userId !== p.userId) return done("error=invalid_state");
  const membership = await resolveMembership(c.get("db"), p.userId, row.orgId);
  if (!membership || !can(membership.role, "workspace.manage")) return done("error=forbidden");
  try {
    const deps = await publishDeps(c.env, c.get("db"));
    let tokens;
    let account;
    if (platform === "mastodon") {
      const instance = row.meta.instance!;
      const client = await mastodonClient(deps, instance);
      tokens = await mastodon.exchange(instance, client, code, row.codeVerifier);
      account = await mastodon.account(instance, tokens);
    } else {
      const cfg = deps.configs[platform as "x" | "linkedin" | "tiktok"];
      if (!cfg) return done("error=not_configured");
      const adapter = platform === "x" ? x : platform === "linkedin" ? linkedin : tiktok;
      tokens = await adapter.exchange(cfg, code, row.codeVerifier);
      account = await adapter.account(tokens);
    }
    await saveConnection(deps, { orgId: row.orgId, platform, account, secret: { tokens }, expiresAt: tokens.expiresAt, meta: row.meta, userId: p.userId });
    return done(`connected=${platform}`);
  } catch (error) {
    console.error("connection callback failed", platform, error instanceof Error ? error.message : error);
    return done("error=connect_failed");
  }
});

// --- Bluesky (app password) --------------------------------------------------------------

connectionsApi.openapi(
  createRoute({
    method: "post",
    path: "/connections/bluesky",
    tags: ["Accounts"],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              identifier: z.string().trim().min(3).max(253),
              // Bluesky app passwords look like xxxx-xxxx-xxxx-xxxx. Refuse anything else, so people
              // don't paste their main account password.
              appPassword: z.string().trim().regex(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/, "Use an app password (Settings → Privacy and security → App passwords), not your main password."),
              service: z.string().trim().max(200).optional(),
            }),
          },
        },
      },
    },
    responses: { 201: json(z.object({ id: z.string(), handle: z.string() }), "Connected"), ...errs },
  }),
  async (c) => {
    const p = c.get("principal");
    if (p.kind !== "user" || !can(p.role, "workspace.manage")) return c.json(apiError("forbidden", "Only owners and admins can connect accounts."), 403);
    const input = c.req.valid("json");
    let service = "https://bsky.social";
    if (input.service) {
      try {
        service = assertSafeUrl(input.service).origin;
      } catch {
        return c.json(apiError("unsafe_url", "That server address isn't allowed."), 400);
      }
    }
    let deps: PublishDeps;
    try {
      deps = await publishDeps(c.env, c.get("db"));
    } catch (error) {
      if (error instanceof EncryptionUnavailableError) return c.json(notConfigured(), 503);
      throw error;
    }
    try {
      const session = await bluesky.session(service, input.identifier, input.appPassword);
      const id = await saveConnection(deps, { orgId: p.orgId, platform: "bluesky", account: session.account, secret: { identifier: input.identifier, appPassword: input.appPassword }, meta: { service }, userId: p.userId });
      return c.json({ id, handle: session.account.handle }, 201);
    } catch (error) {
      if (error instanceof PlatformError) return c.json(apiError("platform_error", error.kind === "auth" ? "Bluesky didn't accept that handle and app password." : error.message), 400);
      throw error;
    }
  },
);

// --- Publishing --------------------------------------------------------------------------

function publishErrorStatus(e: PublishError) {
  return e.code === "not_found" ? 404 : e.code === "insufficient_credits" ? 402 : e.code === "platform_error" ? 502 : 409;
}

connectionsApi.openapi(
  createRoute({
    method: "post",
    path: "/drafts/{id}/publish",
    tags: ["Publishing"],
    request: { params: z.object({ id: z.string() }), body: { required: true, content: { "application/json": { schema: z.object({ connectionId: z.string() }) } } } },
    responses: { 200: json(z.object({ status: z.literal("published"), url: z.string().nullable() })), 402: json(Err, "Needs credits"), 409: json(Err, "Not ready"), 502: json(Err, "Platform error"), ...errs },
  }),
  async (c) => {
    const p = c.get("principal");
    if (!can(p.role, "publish")) return c.json(apiError("forbidden", "Your role can't publish in this workspace."), 403);
    const { id } = c.req.valid("param");
    let deps: PublishDeps;
    try {
      deps = await publishDeps(c.env, c.get("db"));
    } catch (error) {
      if (error instanceof EncryptionUnavailableError) return c.json(notConfigured(), 503);
      throw error;
    }
    if (!(await setDraftConnection(c.get("db"), p.orgId, id, c.req.valid("json").connectionId))) {
      return c.json(apiError("no_connection", "That account isn't connected for this platform."), 409);
    }
    try {
      const out = await publishDraft(deps, { orgId: p.orgId, draftId: id, actorUserId: p.kind === "user" ? p.userId : null });
      return c.json(out, 200);
    } catch (error) {
      if (error instanceof PublishError) return c.json(apiError(error.code, error.message), publishErrorStatus(error));
      throw error;
    }
  },
);

connectionsApi.openapi(
  createRoute({
    method: "post",
    path: "/drafts/{id}/schedule",
    tags: ["Publishing"],
    request: { params: z.object({ id: z.string() }), body: { required: true, content: { "application/json": { schema: z.object({ connectionId: z.string(), at: z.iso.datetime({ offset: true }) }) } } } },
    responses: { 200: json(z.object({ scheduled: z.literal(true) })), 402: json(Err, "Needs credits"), 409: json(Err, "Not ready"), 502: json(Err, "Platform error"), ...errs },
  }),
  async (c) => {
    const p = c.get("principal");
    if (!can(p.role, "publish")) return c.json(apiError("forbidden", "Your role can't schedule posts in this workspace."), 403);
    const body = c.req.valid("json");
    try {
      await scheduleDraft(c.get("db"), p.orgId, c.req.valid("param").id, { at: new Date(body.at), connectionId: body.connectionId });
      return c.json({ scheduled: true as const }, 200);
    } catch (error) {
      if (error instanceof PublishError) return c.json(apiError(error.code, error.message), publishErrorStatus(error));
      throw error;
    }
  },
);

connectionsApi.openapi(
  createRoute({
    method: "get",
    path: "/drafts/{id}/intent",
    tags: ["Publishing"],
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: json(z.object({ url: z.string().nullable() })), ...errs },
  }),
  async (c) => {
    const p = c.get("principal");
    const d = await getDraft(c.get("db"), p.orgId, c.req.valid("param").id);
    if (!d) return c.json(apiError("not_found", "No such post in this workspace."), 404);
    const conns = await listConnections(c.get("db"), p.orgId);
    const instance = conns.find((x) => x.platform === "mastodon")?.meta.instance;
    return c.json({ url: intentUrl(d.platform, d.text, instance ? { mastodonInstance: instance } : {}) }, 200);
  },
);

connectionsApi.openapi(
  createRoute({
    method: "post",
    path: "/drafts/{id}/mark-published",
    tags: ["Publishing"],
    request: { params: z.object({ id: z.string() }), body: { required: true, content: { "application/json": { schema: z.object({ url: z.url({ protocol: /^https$/ }).max(2000).nullable().default(null) }) } } } },
    responses: { 200: json(z.object({ ok: z.literal(true) })), 409: json(Err, "Not ready"), ...errs },
  }),
  async (c) => {
    const p = c.get("principal");
    if (!can(p.role, "publish")) return c.json(apiError("forbidden", "Your role can't publish in this workspace."), 403);
    const ok = await markPublishedManually(c.get("db"), p.orgId, c.req.valid("param").id, c.req.valid("json").url);
    return ok ? c.json({ ok: true as const }, 200) : c.json(apiError("not_ready", "Approve the post first."), 409);
  },
);
