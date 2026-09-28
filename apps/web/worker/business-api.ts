// Phase 6 API: billing (checkout, portal, webhooks), team members, workspaces, audit log, plan comps.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { setCookie } from "hono/cookie";
import { createDb, PAID_PLANS, ROLES } from "@nextrium/db";
import {
  acceptTeamInvite,
  BillingError,
  can,
  changeMemberRole,
  CREDIT_PACKS,
  createCheckout,
  findUserIdByEmail,
  getOrgPlan,
  getSubscription,
  getUserIdentity,
  handleLemonEvent,
  handlePaystackEvent,
  inviteMember,
  isPlatformAdmin,
  listAudit,
  listMembers,
  listWorkspaces,
  PLAN_FEATURES,
  PLAN_PRICES,
  portalUrl,
  previewTeamInvite,
  providersFor,
  recordAudit,
  removeMember,
  revokeTeamInvite,
  setFullAccess,
  listFullAccess,
  setOrgPlan,
  TeamError,
  verifySignature,
  type CheckoutItem,
} from "@nextrium/core";
import { INVITE_COOKIE } from "./auth.js";
import { billingConfig } from "./env.js";
import { apiError, requirePrincipal, type AppEnv, type Principal } from "./principal.js";

export const businessApi = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) return c.json(apiError("invalid_request", result.error.issues.map((i) => i.message).join("; ")), 400);
  },
});
for (const path of ["/billing", "/billing/*", "/team", "/team/*", "/team-invites/accept", "/workspaces", "/audit", "/admin/orgs", "/admin/orgs/*"]) {
  businessApi.use(path, requirePrincipal);
}

const Err = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const json = <T extends z.ZodType>(schema: T, description = "OK") => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { required: true, content: { "application/json": { schema } } } });
const errs = { 400: json(Err, "Invalid"), 401: json(Err, "Not signed in"), 403: json(Err, "Not allowed"), 404: json(Err, "Not found"), 409: json(Err, "Conflict") };

/** Billing and team changes are made by people in the app, never by API keys. */
function manager(p: Principal) {
  return p.kind === "user" && can(p.role, "workspace.manage") ? p : null;
}
const onlyManagers = (what: string) => apiError("forbidden", `Only workspace owners and admins can ${what}, from the app.`);

// --- Billing --------------------------------------------------------------------------------

const ItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan"), plan: z.enum(["lite", "starter", "creator", "pro"]), interval: z.enum(["month", "year"]) }),
  z.object({ kind: z.literal("credits"), pack: z.enum(["c500", "c1100"]) }),
]);

businessApi.openapi(
  createRoute({
    method: "get",
    path: "/billing",
    tags: ["Billing"],
    responses: {
      200: json(
        z.object({
          plan: z.string(),
          fullAccess: z.boolean(),
          features: z.object({ autopilot: z.string(), insights: z.boolean(), seats: z.number() }),
          subscription: z.object({ provider: z.string(), plan: z.string(), interval: z.string(), status: z.string(), currentPeriodEnd: z.string().nullable() }).nullable(),
          catalog: z.array(z.object({ item: ItemSchema, usdCents: z.number(), providers: z.array(z.enum(["paystack", "lemonsqueezy"])) })),
        }),
      ),
      ...errs,
    },
  }),
  async (c) => {
    const { orgId } = c.get("principal");
    const db = c.get("db");
    const cfg = billingConfig(c.env);
    const plan = await getOrgPlan(db, orgId);
    const sub = await getSubscription(db, orgId);
    const items: { item: CheckoutItem; usdCents: number }[] = [
      ...Object.entries(PLAN_PRICES).flatMap(([p, prices]) =>
        Object.entries(prices).map(([interval, usdCents]) => ({ item: { kind: "plan" as const, plan: p as "lite", interval: interval as "month" }, usdCents: usdCents! })),
      ),
      ...Object.entries(CREDIT_PACKS).map(([pack, v]) => ({ item: { kind: "credits" as const, pack: pack as "c500" }, usdCents: v.usdCents })),
    ];
    return c.json(
      {
        plan,
        fullAccess: plan === "staff",
        features: PLAN_FEATURES[plan],
        subscription: sub ? { provider: sub.provider, plan: sub.plan, interval: sub.interval, status: sub.status, currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null } : null,
        catalog: items.map((i) => ({ ...i, providers: providersFor(cfg, i.item) })),
      },
      200,
    );
  },
);

businessApi.openapi(
  createRoute({
    method: "post",
    path: "/billing/checkout",
    tags: ["Billing"],
    request: body(z.object({ provider: z.enum(["paystack", "lemonsqueezy"]), item: ItemSchema })),
    responses: { 200: json(z.object({ url: z.string() })), 502: json(Err, "Provider error"), 503: json(Err, "Not set up"), ...errs },
  }),
  async (c) => {
    const p = manager(c.get("principal"));
    if (!p) return c.json(onlyManagers("buy plans or credits"), 403);
    const { provider, item } = c.req.valid("json");
    const sub = await getSubscription(c.get("db"), p.orgId);
    if (item.kind === "plan" && sub && (sub.status === "active" || sub.status === "past_due")) {
      return c.json(apiError("has_subscription", "This workspace already has a subscription. Change or cancel it from Manage billing."), 409);
    }
    try {
      const url = await createCheckout(billingConfig(c.env), { orgId: p.orgId, email: p.email, provider, item });
      await recordAudit(c.get("db"), { orgId: p.orgId, actorUserId: p.userId, action: "billing.checkout_started", meta: { provider, item } });
      return c.json({ url }, 200);
    } catch (error) {
      if (error instanceof BillingError) return c.json(apiError(error.code, error.message), error.code === "provider_error" ? 502 : error.code === "not_configured" ? 503 : 400);
      throw error;
    }
  },
);

businessApi.openapi(
  createRoute({ method: "post", path: "/billing/portal", tags: ["Billing"], responses: { 200: json(z.object({ url: z.string() })), 502: json(Err, "Provider error"), ...errs } }),
  async (c) => {
    const p = manager(c.get("principal"));
    if (!p) return c.json(onlyManagers("manage billing"), 403);
    const sub = await getSubscription(c.get("db"), p.orgId);
    if (!sub || sub.status === "expired") return c.json(apiError("no_subscription", "This workspace has no subscription."), 404);
    try {
      return c.json({ url: await portalUrl(billingConfig(c.env), sub) }, 200);
    } catch (error) {
      if (error instanceof BillingError) return c.json(apiError(error.code, error.message), 502);
      throw error;
    }
  },
);

// Webhooks: public, authenticated by the provider's signature over the raw body.
const MAX_WEBHOOK_BYTES = 256 * 1024;
async function rawBody(req: Request) {
  if (Number(req.headers.get("Content-Length") ?? 0) > MAX_WEBHOOK_BYTES) return null;
  const text = await req.text();
  return text.length > MAX_WEBHOOK_BYTES ? null : text;
}

businessApi.post("/webhooks/paystack", async (c) => {
  const cfg = billingConfig(c.env);
  if (!cfg.paystack) return c.json(apiError("not_configured", "Paystack isn't set up."), 503);
  const raw = await rawBody(c.req.raw);
  if (raw === null) return c.json(apiError("too_large", "Payload too large."), 413);
  if (!(await verifySignature("paystack", cfg.paystack.secretKey, raw, c.req.header("x-paystack-signature")))) return c.json(apiError("bad_signature", "Invalid signature."), 401);
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return c.json(apiError("invalid_json", "Invalid JSON."), 400);
  }
  const outcome = await handlePaystackEvent(createDb(c.env.DB), cfg, event);
  console.log("paystack webhook", outcome);
  return c.json({ ok: true, outcome }, 200);
});

businessApi.post("/webhooks/lemonsqueezy", async (c) => {
  const cfg = billingConfig(c.env);
  if (!cfg.lemonsqueezy) return c.json(apiError("not_configured", "Lemon Squeezy isn't set up."), 503);
  const raw = await rawBody(c.req.raw);
  if (raw === null) return c.json(apiError("too_large", "Payload too large."), 413);
  if (!(await verifySignature("lemonsqueezy", cfg.lemonsqueezy.webhookSecret, raw, c.req.header("x-signature")))) return c.json(apiError("bad_signature", "Invalid signature."), 401);
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return c.json(apiError("invalid_json", "Invalid JSON."), 400);
  }
  const outcome = await handleLemonEvent(createDb(c.env.DB), cfg, event);
  console.log("lemonsqueezy webhook", outcome);
  return c.json({ ok: true, outcome }, 200);
});

// --- Team ------------------------------------------------------------------------------------

function teamError(e: TeamError) {
  const status = e.code === "not_found" ? 404 : e.code === "forbidden" ? 403 : e.code === "seats" ? 402 : e.code === "invalid_invite" ? 400 : 409;
  return [apiError(e.code, e.message), status] as const;
}

businessApi.openapi(
  createRoute({
    method: "get",
    path: "/team",
    tags: ["Team"],
    responses: {
      200: json(
        z.object({
          seats: z.number(),
          members: z.array(z.object({ id: z.string(), name: z.string(), email: z.string(), role: z.enum(ROLES), createdAt: z.string() })),
          invites: z.array(z.object({ id: z.string(), email: z.string(), role: z.enum(ROLES), expiresAt: z.string() })),
        }),
      ),
      ...errs,
    },
  }),
  async (c) => {
    const { orgId } = c.get("principal");
    const db = c.get("db");
    const { members, invites } = await listMembers(db, orgId);
    return c.json(
      {
        seats: PLAN_FEATURES[await getOrgPlan(db, orgId)].seats,
        members: members.map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, createdAt: m.createdAt.toISOString() })),
        invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt.toISOString() })),
      },
      200,
    );
  },
);

businessApi.openapi(
  createRoute({
    method: "post",
    path: "/team/invites",
    tags: ["Team"],
    request: body(z.object({ email: z.email().max(320), role: z.enum(ROLES) })),
    responses: { 201: json(z.object({ id: z.string(), link: z.string(), expiresAt: z.string() }), "Invited (the link is shown once)"), 402: json(Err, "No seats"), ...errs },
  }),
  async (c) => {
    const p = manager(c.get("principal"));
    if (!p) return c.json(onlyManagers("invite members"), 403);
    const { email, role } = c.req.valid("json");
    try {
      const out = await inviteMember(c.get("db"), { orgId: p.orgId, email, role, actor: { userId: p.userId, role: p.role } });
      return c.json({ id: out.id, link: `${c.env.BETTER_AUTH_URL}/join?token=${out.token}`, expiresAt: out.expiresAt.toISOString() }, 201);
    } catch (error) {
      if (error instanceof TeamError) {
        const [b, s] = teamError(error);
        return c.json(b, s as 402);
      }
      throw error;
    }
  },
);

businessApi.openapi(
  createRoute({ method: "delete", path: "/team/invites/{id}", tags: ["Team"], request: { params: z.object({ id: z.string() }) }, responses: { 204: { description: "Revoked" }, ...errs } }),
  async (c) => {
    const p = manager(c.get("principal"));
    if (!p) return c.json(onlyManagers("revoke invitations"), 403);
    if (!(await revokeTeamInvite(c.get("db"), p.orgId, c.req.valid("param").id, p.userId))) return c.json(apiError("not_found", "No such pending invitation."), 404);
    return c.body(null, 204);
  },
);

businessApi.openapi(
  createRoute({
    method: "patch",
    path: "/team/members/{id}",
    tags: ["Team"],
    request: { params: z.object({ id: z.string() }), ...body(z.object({ role: z.enum(ROLES) })) },
    responses: { 204: { description: "Changed" }, ...errs },
  }),
  async (c) => {
    const p = manager(c.get("principal"));
    if (!p) return c.json(onlyManagers("change roles"), 403);
    try {
      await changeMemberRole(c.get("db"), { orgId: p.orgId, memberId: c.req.valid("param").id, role: c.req.valid("json").role, actor: { userId: p.userId, role: p.role } });
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof TeamError) {
        const [b, s] = teamError(error);
        return c.json(b, s as 409);
      }
      throw error;
    }
  },
);

businessApi.openapi(
  createRoute({ method: "delete", path: "/team/members/{id}", tags: ["Team"], request: { params: z.object({ id: z.string() }) }, responses: { 204: { description: "Removed" }, ...errs } }),
  async (c) => {
    const p = c.get("principal");
    if (p.kind !== "user") return c.json(onlyManagers("remove members"), 403);
    try {
      await removeMember(c.get("db"), { orgId: p.orgId, memberId: c.req.valid("param").id, actor: { userId: p.userId, role: p.role } });
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof TeamError) {
        const [b, s] = teamError(error);
        return c.json(b, s as 409);
      }
      throw error;
    }
  },
);

// The join page: shows which workspace, then (signed out) stores the token for sign-up.
businessApi.openapi(
  createRoute({
    method: "post",
    path: "/team-invites/preview",
    tags: ["Team"],
    request: body(z.object({ token: z.string().max(100) })),
    responses: { 200: json(z.object({ workspace: z.string(), role: z.string(), emailHint: z.string() })), ...errs },
  }),
  async (c) => {
    const { token } = c.req.valid("json");
    const out = await previewTeamInvite(createDb(c.env.DB), token);
    if (!out) return c.json(apiError("invalid_invite", "This invitation is invalid, already used or expired."), 400);
    // Lets the invited email create an account if they don't have one (checked again at sign-up).
    setCookie(c, INVITE_COOKIE, token, { path: "/api/auth", httpOnly: true, secure: c.env.BETTER_AUTH_URL.startsWith("https://"), sameSite: "Lax", maxAge: 30 * 60 });
    return c.json(out, 200);
  },
);

businessApi.openapi(
  createRoute({
    method: "post",
    path: "/team-invites/accept",
    tags: ["Team"],
    request: body(z.object({ token: z.string().max(100) })),
    responses: { 200: json(z.object({ orgId: z.string(), workspace: z.string() })), ...errs },
  }),
  async (c) => {
    const p = c.get("principal");
    if (p.kind !== "user") return c.json(apiError("forbidden", "Sign in to accept an invitation."), 403);
    const u = await getUserIdentity(c.get("db"), p.userId);
    try {
      return c.json(await acceptTeamInvite(c.get("db"), c.req.valid("json").token, { userId: p.userId, email: u?.email ?? "", emailVerified: Boolean(u?.emailVerified) }), 200);
    } catch (error) {
      if (error instanceof TeamError) {
        const [b, s] = teamError(error);
        return c.json(b, s as 400);
      }
      throw error;
    }
  },
);

businessApi.openapi(
  createRoute({
    method: "get",
    path: "/workspaces",
    tags: ["Team"],
    responses: { 200: json(z.object({ data: z.array(z.object({ id: z.string(), name: z.string(), plan: z.string(), role: z.string(), personal: z.boolean() })) })), ...errs },
  }),
  async (c) => {
    const p = c.get("principal");
    if (p.kind !== "user") return c.json({ data: [] }, 200);
    const rows = await listWorkspaces(c.get("db"), p.userId);
    return c.json({ data: rows.map((r) => ({ id: r.id, name: r.name, plan: r.plan, role: r.role, personal: r.personal === p.userId })) }, 200);
  },
);

// --- Audit log ------------------------------------------------------------------------------

businessApi.openapi(
  createRoute({
    method: "get",
    path: "/audit",
    tags: ["Team"],
    request: { query: z.object({ before: z.string().max(40).optional() }) },
    responses: {
      200: json(z.object({ data: z.array(z.object({ id: z.string(), action: z.string(), target: z.string().nullable(), actor: z.string().nullable(), meta: z.unknown(), createdAt: z.string() })) })),
      ...errs,
    },
  }),
  async (c) => {
    const p = c.get("principal");
    if (!can(p.role, "workspace.manage")) return c.json(apiError("forbidden", "Only workspace owners and admins can read the audit log."), 403);
    const rows = await listAudit(c.get("db"), p.orgId, c.req.valid("query").before);
    // Actor emails, for members of this workspace only.
    const { members } = await listMembers(c.get("db"), p.orgId);
    const emails = new Map(members.map((m) => [m.userId, m.email]));
    return c.json(
      {
        data: rows.map((r) => ({
          id: r.id,
          action: r.action,
          target: r.target,
          actor: r.actorApiKeyId ? `API key ${r.actorApiKeyId.slice(0, 12)}` : r.actorUserId ? (emails.get(r.actorUserId) ?? "former member") : "Showrium",
          meta: r.meta,
          createdAt: r.createdAt.toISOString(),
        })),
      },
      200,
    );
  },
);

// --- Platform admin: plan comps (beta testers, support) ---------------------------------------

function platformAdmin(c: { get: (k: "principal") => Principal; env: { PLATFORM_ADMIN_EMAILS?: string } }) {
  const p = c.get("principal");
  return p.kind === "user" && isPlatformAdmin(p.email, c.env.PLATFORM_ADMIN_EMAILS) ? p : null;
}

businessApi.openapi(
  createRoute({
    method: "get",
    path: "/admin/orgs",
    tags: ["Admin"],
    request: { query: z.object({ email: z.email().max(320) }) },
    responses: { 200: json(z.object({ data: z.array(z.object({ id: z.string(), name: z.string(), plan: z.string(), fullAccess: z.boolean(), role: z.string() })) })), ...errs },
  }),
  async (c) => {
    if (!platformAdmin(c)) return c.json(apiError("forbidden", "Only Showrium staff can look up workspaces."), 403);
    const db = c.get("db");
    const userId = await findUserIdByEmail(db, c.req.valid("query").email);
    if (!userId) return c.json({ data: [] }, 200);
    return c.json({ data: (await listWorkspaces(db, userId)).map((w) => ({ id: w.id, name: w.name, plan: w.plan, fullAccess: w.fullAccess, role: w.role })) }, 200);
  },
);

businessApi.openapi(
  createRoute({
    method: "put",
    path: "/admin/orgs/{id}/plan",
    tags: ["Admin"],
    request: { params: z.object({ id: z.string() }), ...body(z.object({ plan: z.enum(["free", ...PAID_PLANS]), note: z.string().trim().min(3).max(200) })) },
    responses: { 204: { description: "Changed" }, ...errs },
  }),
  async (c) => {
    const admin = platformAdmin(c);
    if (!admin) return c.json(apiError("forbidden", "Only Showrium staff can change plans."), 403);
    const { plan, note } = c.req.valid("json");
    const ok = await setOrgPlan(c.get("db"), c.req.valid("param").id, plan, { actorUserId: admin.userId, reason: `admin: ${note}` });
    return ok ? c.body(null, 204) : c.json(apiError("not_found", "No such workspace."), 404);
  },
);

// Full access: platform admins grant it to specific workspaces (their own, testers, partners).
// Plans still limit everyone else. Quality never differs; only quantity and capabilities do.
businessApi.openapi(
  createRoute({
    method: "put",
    path: "/admin/orgs/{id}/access",
    tags: ["Admin"],
    request: { params: z.object({ id: z.string() }), ...body(z.object({ full: z.boolean(), note: z.string().trim().min(3).max(200) })) },
    responses: { 204: { description: "Changed" }, ...errs },
  }),
  async (c) => {
    const admin = platformAdmin(c);
    if (!admin) return c.json(apiError("forbidden", "Only Showrium staff can grant access."), 403);
    const { full, note } = c.req.valid("json");
    const ok = await setFullAccess(c.get("db"), c.req.valid("param").id, { full, note, actorUserId: admin.userId });
    return ok ? c.body(null, 204) : c.json(apiError("not_found", "No such workspace."), 404);
  },
);

businessApi.use("/admin/access", requirePrincipal);
businessApi.openapi(
  createRoute({
    method: "get",
    path: "/admin/access",
    tags: ["Admin"],
    responses: { 200: json(z.object({ data: z.array(z.object({ id: z.string(), name: z.string(), note: z.string().nullable(), at: z.string().nullable() })) })), ...errs },
  }),
  async (c) => {
    if (!platformAdmin(c)) return c.json(apiError("forbidden", "Only Showrium staff can see access grants."), 403);
    const rows = await listFullAccess(c.get("db"));
    return c.json({ data: rows.map((r) => ({ id: r.id, name: r.name, note: r.note, at: r.at?.toISOString() ?? null })) }, 200);
  },
);
