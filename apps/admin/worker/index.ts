// The admin app's API. Every call: Cloudflare Access identity → staff role → permission check.
// Every change is written to the admin action log. No destructive operations: plans and access
// can be changed and changed back, invites replace older ones, staff removal is a soft revoke.
import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { createDb, PAID_PLANS, STAFF_ROLES, type Db, type StaffRole } from "@nextrium/db";
import {
  adminOverview,
  inviteFromWaitlist,
  inviteStaff,
  listAdminAudit,
  listFullAccess,
  listStaff,
  listWaitlist,
  recordAdminAudit,
  searchUsers,
  sendEmail,
  setFullAccess,
  setOrgPlan,
  staffCan,
  staffInviteEmail,
  STAFF_PERMISSIONS,
  StaffError,
  staffRoleByEmail,
  updateStaff,
  userDetail,
  waitlistInviteEmail,
  type StaffPermission,
} from "@nextrium/core";
import { identify } from "./access.js";
import type { Env } from "./env.js";

type Vars = { db: Db; email: string; role: StaffRole };
type AdminEnv = { Bindings: Env; Variables: Vars };
type C = Context<AdminEnv>;

const app = new Hono<AdminEnv>();
const err = (code: string, message: string) => ({ error: { code, message } });

app.use("/api/*", secureHeaders({ strictTransportSecurity: "max-age=31536000; includeSubDomains", xFrameOptions: "DENY", referrerPolicy: "no-referrer", crossOriginResourcePolicy: "same-origin" }));

// Admin data is never cached by browsers or proxies.
app.use("/api/*", async (c, next) => {
  await next();
  c.res = new Response(c.res.body, c.res);
  c.res.headers.set("Cache-Control", "no-store");
  c.res.headers.set("X-Robots-Tag", "noindex, nofollow");
});

// Who is it, and are they staff? Closed by default.
app.use("/api/*", async (c, next) => {
  // Changes only from this app's own pages (blocks cross-site requests).
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    if (origin !== new URL(c.env.ADMIN_URL).origin) return c.json(err("forbidden", "Changes must come from the admin app."), 403);
    if (!c.req.header("Content-Type")?.startsWith("application/json")) return c.json(err("invalid_request", "Send JSON."), 415);
  }
  const email = await identify(c.req.raw, c.env);
  if (!email) return c.json(err("unauthenticated", "Sign in through Cloudflare Access."), 401);
  const db = createDb(c.env.DB);
  const role = await staffRoleByEmail(db, email, c.env.PLATFORM_ADMIN_EMAILS);
  if (!role) return c.json(err("forbidden", "This account isn't Showrium staff."), 403);
  c.set("db", db);
  c.set("email", email);
  c.set("role", role);
  await next();
});

const allowed = (c: C, permission: StaffPermission) => staffCan(c.get("role"), permission);
const denied = (c: C) => c.json(err("forbidden", "Your role can't do this."), 403);
async function body<T extends z.ZodType>(c: C, schema: T): Promise<z.infer<T> | null> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}
const audit = (c: C, action: string, target: string | null, meta?: Record<string, unknown>) => recordAdminAudit(c.get("db"), { actorEmail: c.get("email"), action, target, meta: meta ?? null });
const inviteLink = (env: Env, token: string) => `${new URL(env.APP_URL).origin}/invite?token=${encodeURIComponent(token)}`;

app.get("/api/me", (c) => c.json({ email: c.get("email"), role: c.get("role"), permissions: STAFF_PERMISSIONS[c.get("role")], appUrl: c.env.APP_URL }));

app.get("/api/overview", async (c) => (allowed(c, "overview") ? c.json(await adminOverview(c.get("db"))) : denied(c)));

// --- Waitlist ---------------------------------------------------------------------------------

app.get("/api/waitlist", async (c) => {
  if (!allowed(c, "waitlist")) return denied(c);
  const rows = await listWaitlist(c.get("db"));
  return c.json({ data: rows.map((r) => ({ ...r, joinedListAt: r.joinedListAt.toISOString(), invitedAt: r.invitedAt?.toISOString() ?? null, joinedAt: r.joinedAt?.toISOString() ?? null })) });
});

app.post("/api/waitlist/invite", async (c) => {
  if (!allowed(c, "waitlist")) return denied(c);
  const input = await body(c, z.object({ ids: z.array(z.string().max(64)).min(1).max(50) }));
  if (!input) return c.json(err("invalid_request", "Choose 1 to 50 people."), 400);
  const created = await inviteFromWaitlist(c.get("db"), { entryIds: input.ids, adminUserId: null });
  const data = [];
  for (const inv of created) {
    const link = inviteLink(c.env, inv.token);
    let sent = false;
    try {
      sent = (await sendEmail(c.env, waitlistInviteEmail(inv.email, link))).sent;
    } catch (error) {
      console.error("waitlist invite email failed", error instanceof Error ? error.message : error);
    }
    await audit(c, "waitlist.invited", inv.email, { sent });
    data.push({ id: inv.entryId, email: inv.email, sent, link: sent ? null : link });
  }
  return c.json({ data, skipped: new Set(input.ids).size - created.length });
});

// --- Users and workspaces --------------------------------------------------------------------

app.get("/api/users", async (c) => {
  if (!allowed(c, "users")) return denied(c);
  const rows = await searchUsers(c.get("db"), c.req.query("q") ?? "");
  return c.json({ data: rows.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() })) });
});

app.get("/api/users/:id", async (c) => {
  if (!allowed(c, "users")) return denied(c);
  const u = await userDetail(c.get("db"), c.req.param("id"));
  if (!u) return c.json(err("not_found", "No such account."), 404);
  await audit(c, "user.viewed", u.email);
  return c.json({ ...u, createdAt: u.createdAt.toISOString() });
});

app.put("/api/workspaces/:id/plan", async (c) => {
  if (!allowed(c, "users.manage")) return denied(c);
  const input = await body(c, z.object({ plan: z.enum(["free", ...PAID_PLANS]), seats: z.number().int().min(2).max(5).optional(), note: z.string().trim().min(3).max(200) }));
  if (!input) return c.json(err("invalid_request", "Choose a plan and give a reason."), 400);
  const ok = await setOrgPlan(c.get("db"), c.req.param("id"), input.plan, { actorUserId: null, reason: `admin (${c.get("email")}): ${input.note}`, seats: input.plan === "team_seats" ? (input.seats ?? 2) : null });
  if (!ok) return c.json(err("not_found", "No such workspace."), 404);
  await audit(c, "workspace.plan_changed", c.req.param("id"), { plan: input.plan, note: input.note });
  return c.body(null, 204);
});

app.put("/api/workspaces/:id/access", async (c) => {
  if (!allowed(c, "users.manage")) return denied(c);
  const input = await body(c, z.object({ full: z.boolean(), note: z.string().trim().min(3).max(200) }));
  if (!input) return c.json(err("invalid_request", "Give a reason."), 400);
  const ok = await setFullAccess(c.get("db"), c.req.param("id"), { full: input.full, note: input.note, actorUserId: `staff:${c.get("email")}` });
  if (!ok) return c.json(err("not_found", "No such workspace."), 404);
  await audit(c, input.full ? "workspace.access_granted" : "workspace.access_removed", c.req.param("id"), { note: input.note });
  return c.body(null, 204);
});

app.get("/api/access", async (c) => {
  if (!allowed(c, "users.manage")) return denied(c);
  const rows = await listFullAccess(c.get("db"));
  return c.json({ data: rows.map((r) => ({ id: r.id, name: r.name, note: r.note, at: r.at?.toISOString() ?? null })) });
});

// --- Staff ---------------------------------------------------------------------------------------

app.get("/api/staff", async (c) => {
  if (!allowed(c, "staff")) return denied(c);
  const rows = await listStaff(c.get("db"), c.env.PLATFORM_ADMIN_EMAILS);
  return c.json({ data: rows.map((r) => ({ ...r, acceptedAt: r.acceptedAt?.toISOString() ?? null, createdAt: r.createdAt?.toISOString() ?? null })) });
});

const staffError = (c: C, e: StaffError) => c.json(err(e.code, e.message), e.code === "forbidden" ? 403 : e.code === "not_found" ? 404 : e.code === "exists" ? 409 : 400);

app.post("/api/staff", async (c) => {
  if (!allowed(c, "staff")) return denied(c);
  const input = await body(c, z.object({ email: z.string().trim().max(320), role: z.enum(STAFF_ROLES) }));
  if (!input) return c.json(err("invalid_request", "Enter an email and choose a role."), 400);
  try {
    const out = await inviteStaff(c.get("db"), { email: input.email, role: input.role, actor: { email: c.get("email"), role: c.get("role") } });
    let sent = false;
    let link: string | null = null;
    if (out.token) {
      link = inviteLink(c.env, out.token);
      try {
        sent = (await sendEmail(c.env, staffInviteEmail(out.email, link, out.role))).sent;
      } catch (error) {
        console.error("staff invite email failed", error instanceof Error ? error.message : error);
      }
    }
    return c.json({ email: out.email, role: out.role, hasAccount: out.hasAccount, sent, link: sent ? null : link }, 201);
  } catch (error) {
    if (error instanceof StaffError) return staffError(c, error);
    throw error;
  }
});

app.patch("/api/staff/:id", async (c) => {
  if (!allowed(c, "staff")) return denied(c);
  const input = await body(c, z.object({ role: z.enum(STAFF_ROLES).optional(), remove: z.boolean().optional() }));
  if (!input || (!input.role && !input.remove)) return c.json(err("invalid_request", "Choose a role, or remove."), 400);
  try {
    await updateStaff(c.get("db"), { id: c.req.param("id"), role: input.role, remove: input.remove, actor: { email: c.get("email"), role: c.get("role") } });
    return c.body(null, 204);
  } catch (error) {
    if (error instanceof StaffError) return staffError(c, error);
    throw error;
  }
});

// --- Activity ------------------------------------------------------------------------------------

app.get("/api/audit", async (c) => {
  if (!allowed(c, "audit")) return denied(c);
  const rows = await listAdminAudit(c.get("db"));
  return c.json({ data: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) });
});

app.all("/api/*", (c) => c.json(err("not_found", "No such endpoint."), 404));

export default app;
