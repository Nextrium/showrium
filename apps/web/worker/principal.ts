// Who is calling, and in which org. Every /api/v1 handler reads the org from here,
// never from the request body, so one tenant can't reach another tenant's data.
import { createMiddleware } from "hono/factory";
import { createDb, type Db, type Role } from "@nextrium/db";
import { canManageApiKeys, ensurePersonalOrg, resolveApiKey, resolveMembership } from "@nextrium/core";
import { createAuth } from "./auth.js";
import type { Env } from "./env.js";

export type Principal =
  | { kind: "user"; userId: string; email: string; orgId: string; role: Role }
  | { kind: "api_key"; apiKeyId: string; orgId: string; role: "admin" };

export type AppVariables = { db: Db; principal: Principal };
export type AppEnv = { Bindings: Env; Variables: AppVariables };

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function apiError(code: string, message: string) {
  return { error: { code, message } };
}

export const requirePrincipal = createMiddleware<AppEnv>(async (c, next) => {
  const db = createDb(c.env.DB);
  c.set("db", db);

  const authorization = c.req.header("Authorization");
  if (authorization?.startsWith("Bearer ")) {
    const key = await resolveApiKey(db, authorization.slice("Bearer ".length).trim());
    if (!key) return c.json(apiError("invalid_api_key", "The API key is missing, wrong or revoked."), 401);
    c.set("principal", { kind: "api_key", apiKeyId: key.id, orgId: key.orgId, role: "admin" });
    return next();
  }

  const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json(apiError("unauthenticated", "Sign in or send an API key as 'Authorization: Bearer <key>'."), 401);

  // Cookie sessions: block cross-site form posts (CSRF) on writes.
  if (MUTATING.has(c.req.method)) {
    const origin = c.req.header("Origin");
    if (origin !== new URL(c.env.BETTER_AUTH_URL).origin) {
      return c.json(apiError("bad_origin", "Requests that change data must come from the Showrium app."), 403);
    }
  }

  const requestedOrgId = c.req.header("X-Org-Id") ?? undefined;
  let membership = await resolveMembership(db, session.user.id, requestedOrgId);
  if (!membership && !requestedOrgId) {
    // The sign-up hook may have failed to create the workspace. Create it now if none exists.
    await ensurePersonalOrg(db, { userId: session.user.id, userName: session.user.name });
    membership = await resolveMembership(db, session.user.id);
  }
  if (!membership) return c.json(apiError("no_workspace", "You don't have access to this workspace."), 403);
  c.set("principal", { kind: "user", userId: session.user.id, email: session.user.email, orgId: membership.orgId, role: membership.role });
  return next();
});

export function canManageKeys(principal: Principal): boolean {
  return canManageApiKeys(principal.kind, principal.role);
}
