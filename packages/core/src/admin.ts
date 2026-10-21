// The admin app's data: totals for the overview, finding accounts, and the admin action log.
// Totals only on the overview (no one's content); account details show settings and usage, not posts.
import { and, desc, eq, gte, inArray, like, sql } from "drizzle-orm";
import { adminAudit, aiUsage, auditEvent, brief, draft, membership, org, staffMember, subscription, twoFactor, user, type Db, type StaffRole } from "@nextrium/db";
import { isPlatformAdmin } from "./access.js";
import { chunkRows } from "./chunk.js";
import { newId } from "./ids.js";
import { getUsage } from "./plans.js";
import { listWorkspaces } from "./team.js";
import { listWaitlist } from "./waitlist.js";

/** Staff role for an email whose ownership is already proven (Cloudflare Access signed it in). */
export async function staffRoleByEmail(db: Db, email: string, ownerList: string | undefined): Promise<StaffRole | null> {
  if (isPlatformAdmin(email, ownerList)) return "owner";
  const [row] = await db.select({ id: staffMember.id, role: staffMember.role, acceptedAt: staffMember.acceptedAt, revokedAt: staffMember.revokedAt }).from(staffMember).where(eq(staffMember.email, email.trim().toLowerCase()));
  if (!row || row.revokedAt) return null;
  if (!row.acceptedAt) await db.update(staffMember).set({ acceptedAt: new Date() }).where(eq(staffMember.id, row.id));
  return row.role;
}

export async function recordAdminAudit(db: Db, input: { actorEmail: string; action: string; target?: string | null; meta?: Record<string, unknown> | null }) {
  await db.insert(adminAudit).values({ id: newId("adm"), actorEmail: input.actorEmail, action: input.action, target: input.target ?? null, meta: input.meta ?? null });
}

export async function listAdminAudit(db: Db, limit = 200) {
  return db.select().from(adminAudit).orderBy(desc(adminAudit.createdAt)).limit(Math.min(500, Math.max(1, limit)));
}

const DAY = 86_400_000;
const day = (d: Date) => d.toISOString().slice(0, 10);

// --- Who pays, and who was given access ----------------------------------------------------------

export const ACCESS_KINDS = ["paying", "granted", "full_access", "free"] as const;
export type AccessKind = (typeof ACCESS_KINDS)[number];

/** A subscription still being paid for: active, late on a payment, or cancelled but inside its paid period. */
const PAID_STATUSES = ["active", "past_due", "cancelled"];

/**
 * What a workspace is, for revenue and support: full access given by staff; paying (a subscription
 * still in force); granted (a plan above Free with no paying subscription, given by staff); or free.
 * A lapsed subscription puts the plan back to Free (billing.ts), so it never reads as granted.
 */
export function accessKindOf(w: { plan: string; fullAccess: boolean }, sub: { status: string } | null | undefined): AccessKind {
  if (w.fullAccess) return "full_access";
  if (sub && PAID_STATUSES.includes(sub.status)) return "paying";
  return w.plan === "free" ? "free" : "granted";
}

/** Every workspace with its kind (the admin app's numbers stay small: one row per workspace). */
async function workspaceKinds(db: Db) {
  const rows = await db
    .select({ id: org.id, name: org.name, plan: org.plan, fullAccess: org.fullAccess, fullAccessNote: org.fullAccessNote, fullAccessBy: org.fullAccessBy, fullAccessAt: org.fullAccessAt, status: subscription.status, provider: subscription.provider, createdAt: org.createdAt })
    .from(org)
    .leftJoin(subscription, eq(subscription.orgId, org.id));
  return rows.map((r) => ({ ...r, kind: accessKindOf(r, r.status ? { status: r.status } : null) }));
}

/**
 * The workspaces of one kind, newest first (at most 200), with their owner and, for access given by
 * staff, who gave it, when and why. For revenue reviews and support; no content.
 */
export async function workspacesByKind(db: Db, kind: AccessKind) {
  const rows = (await workspaceKinds(db)).filter((r) => r.kind === kind).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 200);
  const ids = rows.map((r) => r.id);
  const owners = new Map<string, string>();
  const grants = new Map<string, { reason: string; at: Date }>();
  for (const chunk of chunkRows(ids, 1)) {
    for (const o of await db.select({ orgId: membership.orgId, email: user.email }).from(membership).innerJoin(user, eq(user.id, membership.userId)).where(and(inArray(membership.orgId, chunk), eq(membership.role, "owner")))) {
      if (!owners.has(o.orgId)) owners.set(o.orgId, o.email);
    }
    if (kind === "granted") {
      // The latest plan change says who granted it and why ("admin (email): note").
      for (const e of await db.select({ orgId: auditEvent.orgId, meta: auditEvent.meta, at: auditEvent.createdAt }).from(auditEvent).where(and(inArray(auditEvent.orgId, chunk), eq(auditEvent.action, "plan.changed"))).orderBy(desc(auditEvent.createdAt))) {
        if (e.orgId && !grants.has(e.orgId)) grants.set(e.orgId, { reason: String((e.meta as { reason?: unknown } | null)?.reason ?? ""), at: e.at });
      }
    }
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    plan: r.plan,
    kind: r.kind,
    owner: owners.get(r.id) ?? null,
    subscription: r.status ? { status: r.status, provider: r.provider } : null,
    given:
      r.kind === "full_access"
        ? { by: r.fullAccessBy?.replace(/^staff:/, "") ?? null, note: r.fullAccessNote, at: r.fullAccessAt?.toISOString() ?? null }
        : r.kind === "granted"
          ? { by: null, note: grants.get(r.id)?.reason ?? null, at: grants.get(r.id)?.at.toISOString() ?? null }
          : null,
  }));
}

/** The overview: totals and the last 14 days, from counts only. */
export async function adminOverview(db: Db, now = new Date()) {
  const since30 = new Date(now.getTime() - 30 * DAY);
  const since14 = new Date(now.getTime() - 13 * DAY);
  since14.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const count = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
  const n = sql<number>`count(*)`;

  const [users, users30, posts30, published30, failed30] = await Promise.all([
    count(db.select({ n }).from(user)),
    count(db.select({ n }).from(user).where(gte(user.createdAt, since30))),
    count(db.select({ n }).from(draft).where(gte(draft.createdAt, since30))),
    count(db.select({ n }).from(draft).where(and(eq(draft.status, "published"), gte(draft.publishedAt, since30)))),
    count(db.select({ n }).from(draft).where(and(eq(draft.status, "failed"), gte(draft.createdAt, since30)))),
  ]);
  const plans = await db.select({ plan: org.plan, fullAccess: org.fullAccess, n }).from(org).groupBy(org.plan, org.fullAccess);
  // Every AI call (posts, research, insights, images, video, voice), not just written posts.
  const [cost] = await db.select({ micro: sql<number>`coalesce(sum(${aiUsage.costMicroUsd}), 0)` }).from(aiUsage).where(gte(aiUsage.createdAt, monthStart));
  const subs = await db.select({ status: subscription.status, n }).from(subscription).groupBy(subscription.status);
  const kinds = Object.fromEntries(ACCESS_KINDS.map((k) => [k, 0])) as Record<AccessKind, number>;
  for (const w of await workspaceKinds(db)) kinds[w.kind]++;
  const waitlist = await listWaitlist(db, now.getTime());

  // Daily series (UTC days): sign-ups, posts written, posts published.
  const series = new Map<string, { signups: number; written: number; published: number }>();
  for (let i = 0; i < 14; i++) series.set(day(new Date(since14.getTime() + i * DAY)), { signups: 0, written: 0, published: 0 });
  const bump = (d: Date | null, k: "signups" | "written" | "published") => {
    const row = d ? series.get(day(d)) : undefined;
    if (row) row[k]++;
  };
  for (const r of await db.select({ at: user.createdAt }).from(user).where(gte(user.createdAt, since14))) bump(r.at, "signups");
  for (const r of await db.select({ at: draft.createdAt }).from(draft).where(gte(draft.createdAt, since14))) bump(r.at, "written");
  for (const r of await db.select({ at: draft.publishedAt }).from(draft).where(and(eq(draft.status, "published"), gte(draft.publishedAt, since14)))) bump(r.at, "published");

  return {
    users: { total: users, last30Days: users30 },
    posts: { written30Days: posts30, published30Days: published30, failed30Days: failed30 },
    plans: plans.map((p) => ({ plan: p.fullAccess ? "staff" : p.plan, workspaces: Number(p.n) })),
    subscriptions: Object.fromEntries(subs.map((s) => [s.status, Number(s.n)])),
    /** Workspaces by kind: paying, granted a plan, full access, free. Granted and full access are never revenue. */
    kinds,
    aiCostThisMonthUsd: Math.round(Number(cost?.micro ?? 0)) / 1_000_000,
    waitlist: {
      waiting: waitlist.filter((w) => w.status === "waiting").length,
      invited: waitlist.filter((w) => w.status === "invited" || w.status === "invite_expired").length,
      joined: waitlist.filter((w) => w.status === "joined").length,
    },
    daily: [...series.entries()].map(([date, v]) => ({ date, ...v })),
  };
}

/** Accounts whose email contains the text (at most 50, newest first). */
export async function searchUsers(db: Db, query: string) {
  const q = query.trim().toLowerCase().replace(/[%_\\]/g, "");
  if (q.length < 2) return [];
  return db
    .select({ id: user.id, name: user.name, email: user.email, verified: user.emailVerified, createdAt: user.createdAt })
    .from(user)
    .where(like(sql`lower(${user.email})`, `%${q}%`))
    .orderBy(desc(user.createdAt))
    .limit(50);
}

/** One account: who, security settings, and each workspace with its plan and this month's usage. No posts. */
export async function userDetail(db: Db, userId: string) {
  const [u] = await db.select({ id: user.id, name: user.name, email: user.email, verified: user.emailVerified, createdAt: user.createdAt }).from(user).where(eq(user.id, userId));
  if (!u) return null;
  const [tf] = await db.select({ id: twoFactor.id }).from(twoFactor).where(eq(twoFactor.userId, userId));
  const workspaces = await listWorkspaces(db, userId);
  const usage = await Promise.all(workspaces.map((w) => getUsage(db, w.id)));
  const subs = new Map<string, { status: string; plan: string; provider: string }>();
  for (const chunk of chunkRows(workspaces.map((w) => w.id), 1)) {
    for (const s of await db.select({ orgId: subscription.orgId, status: subscription.status, plan: subscription.plan, provider: subscription.provider }).from(subscription).where(inArray(subscription.orgId, chunk))) subs.set(s.orgId, s);
  }
  return {
    ...u,
    twoFactor: Boolean(tf),
    workspaces: workspaces.map((w, i) => ({ id: w.id, name: w.name, plan: w.plan, fullAccess: w.fullAccess, kind: accessKindOf(w, subs.get(w.id)), role: w.role, personal: Boolean(w.personal), usage: usage[i]!, subscription: subs.get(w.id) ?? null })),
  };
}
