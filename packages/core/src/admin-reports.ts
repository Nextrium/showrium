// Admin app, phase 2: publishing health, billing, abuse signals, and pausing a workspace.
// Read-only reports, except Pause/Resume (reversible; nothing is deleted). Every function is staff-only:
// the admin Worker checks the staff permission before calling them.
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { autopilot, connection, creditEntry, creditTxn, draft, org, paymentEvent, session, source, subscription, user } from "@nextrium/db";
import type { Db } from "@nextrium/db";
import { aiCostFor } from "./ai-usage.js";
import { planPriceCents } from "./billing.js";

const MINUTE = 60_000;
const DAY = 86_400_000;

// --- Publishing health ------------------------------------------------------------------------

/** How posting is going: per platform, the top reasons posts fail, accounts to reconnect, stuck or overdue posts, and the background jobs. */
/** Part of the message a post gets when our platform API account is out of paid usage (see the platforms package). */
export const PROVIDER_BILLING_MARK = "This is on our side, not your account";

export async function publishingHealth(db: Db, now = new Date()) {
  const since30 = new Date(now.getTime() - 30 * DAY);
  const since7 = new Date(now.getTime() - 7 * DAY);
  const outcomes = await db
    .select({ platform: draft.platform, status: draft.status, at: draft.updatedAt, method: draft.publishMethod, error: draft.lastError })
    .from(draft)
    .where(and(inArray(draft.status, ["published", "failed"]), gte(draft.updatedAt, since30)));
  const platforms = new Map<string, { published7: number; failed7: number; published30: number; failed30: number }>();
  const reasons = new Map<string, { reason: string; platform: string; count: number }>();
  for (const o of outcomes) {
    const p = platforms.get(o.platform) ?? { published7: 0, failed7: 0, published30: 0, failed30: 0 };
    platforms.set(o.platform, p);
    const recent = o.at >= since7;
    if (o.status === "published") {
      p.published30++;
      if (recent) p.published7++;
    } else {
      p.failed30++;
      if (recent) p.failed7++;
      // Group by the message without numbers, so "HTTP 400" variants of one problem count together.
      const reason = (o.error ?? "No reason recorded").replace(/\d+/g, "#").slice(0, 160);
      const key = `${o.platform}|${reason}`;
      reasons.set(key, { reason: o.error?.slice(0, 200) ?? "No reason recorded", platform: o.platform, count: (reasons.get(key)?.count ?? 0) + 1 });
    }
  }
  const reconnect = await db
    .select({ orgId: connection.orgId, orgName: org.name, platform: connection.platform, handle: connection.handle, since: connection.updatedAt })
    .from(connection)
    .innerJoin(org, eq(org.id, connection.orgId))
    .where(eq(connection.status, "needs_reconnect"))
    .orderBy(desc(connection.updatedAt))
    .limit(50);
  const stuck = await db
    .select({ id: draft.id, orgId: draft.orgId, platform: draft.platform, since: draft.updatedAt })
    .from(draft)
    .where(and(eq(draft.status, "publishing"), lt(draft.updatedAt, new Date(now.getTime() - 15 * MINUTE))))
    .limit(50);
  const overdue = await db
    .select({ id: draft.id, orgId: draft.orgId, platform: draft.platform, due: draft.scheduledAt })
    .from(draft)
    .where(and(eq(draft.status, "scheduled"), lt(draft.scheduledAt, new Date(now.getTime() - 15 * MINUTE))))
    .limit(50);
  // Background jobs: when each last did something (they run every few minutes when there's work).
  const [auto] = await db.select({ at: sql<number | null>`max(${autopilot.lastRunAt})` }).from(autopilot);
  const [src] = await db.select({ at: sql<number | null>`max(${source.lastCheckedAt})` }).from(source);
  const [pub] = await db.select({ at: sql<number | null>`max(${draft.publishedAt})` }).from(draft).where(eq(draft.publishMethod, "api"));
  // Our own developer account with a platform out of paid API usage (X: "credits depleted"): every
  // post through it fails until staff top it up, so it's shown first.
  const outOfCredit = new Map<string, Date>();
  for (const o of outcomes) if (o.status === "failed" && o.at >= new Date(now.getTime() - DAY) && o.error?.includes(PROVIDER_BILLING_MARK)) outOfCredit.set(o.platform, o.at > (outOfCredit.get(o.platform) ?? new Date(0)) ? o.at : outOfCredit.get(o.platform)!);
  const iso = (n: number | null | undefined) => (n ? new Date(Number(n)).toISOString() : null);
  return {
    providerCredit: [...outOfCredit.entries()].map(([platform, at]) => ({ platform, lastFailedAt: at.toISOString() })),
    platforms: [...platforms.entries()].map(([platform, p]) => ({ platform, ...p, failRate30: p.published30 + p.failed30 ? Math.round((p.failed30 / (p.published30 + p.failed30)) * 100) : 0 })).sort((a, b) => b.failed30 - a.failed30),
    reasons: [...reasons.values()].sort((a, b) => b.count - a.count).slice(0, 10),
    reconnect: reconnect.map((r) => ({ ...r, since: r.since.toISOString() })),
    stuck: stuck.map((s) => ({ ...s, since: s.since.toISOString() })),
    overdue: overdue.map((o) => ({ ...o, due: o.due?.toISOString() ?? null })),
    jobs: {
      // Overdue posts mean the posting job isn't keeping up (or is paused): that's the warning.
      posting: { lastPublishedAt: iso(pub?.at), behind: overdue.length > 0 },
      automation: { lastRunAt: iso(auto?.at) },
      sources: { lastCheckedAt: iso(src?.at), late: Boolean(src?.at && now.getTime() - Number(src.at) > 6 * 60 * MINUTE) },
    },
  };
}

// --- Billing ------------------------------------------------------------------------------------

export const PROBLEM_OUTCOMES = ["amount_mismatch", "unknown_item", "unknown_subscription", "not_paid", "ignored_unsigned"];

/** Paying workspaces, monthly revenue, past-due ones to follow up, payment events and credits. Read-only. */
export async function billingReport(db: Db, now = new Date()) {
  const subs = await db
    .select({ orgId: subscription.orgId, orgName: org.name, provider: subscription.provider, plan: subscription.plan, interval: subscription.interval, seats: subscription.seats, status: subscription.status, renews: subscription.currentPeriodEnd })
    .from(subscription)
    .innerJoin(org, eq(org.id, subscription.orgId))
    .orderBy(desc(subscription.currentPeriodEnd));
  let mrrCents = 0;
  const counts: Record<string, number> = { active: 0, past_due: 0, cancelled: 0, expired: 0 };
  const rows = subs.map((s) => {
    counts[s.status] = (counts[s.status] ?? 0) + 1;
    const cents = planPriceCents(s.plan, s.interval, s.seats ?? undefined) ?? 0;
    const monthly = s.interval === "year" ? cents / 12 : cents;
    // Revenue counts active and past-due (still being retried); cancelled ones run to their period end.
    if (s.status === "active" || s.status === "past_due") mrrCents += monthly;
    return { ...s, renews: s.renews?.toISOString() ?? null, monthlyUsd: Math.round(monthly) / 100 };
  });
  const events = await db
    .select({ provider: paymentEvent.provider, type: paymentEvent.type, outcome: paymentEvent.outcome, orgId: paymentEvent.orgId, at: paymentEvent.createdAt })
    .from(paymentEvent)
    .orderBy(desc(paymentEvent.createdAt))
    .limit(50);
  // Credits: what people bought, what was granted, what they spent, and what's still on their balances.
  const byKind = await db
    .select({ kind: creditTxn.kind, total: sql<number>`coalesce(sum(${creditEntry.amount}), 0)` })
    .from(creditEntry)
    .innerJoin(creditTxn, eq(creditTxn.id, creditEntry.txnId))
    .where(eq(creditEntry.account, "org"))
    .groupBy(creditTxn.kind);
  const kind = (k: string) => Number(byKind.find((r) => r.kind === k)?.total ?? 0);
  const [bal] = await db.select({ total: sql<number>`coalesce(sum(${creditEntry.amount}), 0)` }).from(creditEntry).where(eq(creditEntry.account, "org"));
  return {
    mrrUsd: Math.round(mrrCents) / 100,
    counts,
    subscriptions: rows,
    pastDue: rows.filter((r) => r.status === "past_due"),
    events: events.map((e) => ({ ...e, at: e.at.toISOString() })),
    // Outcomes worth a look (billing.ts): wrong amount, unknown item or subscription, unpaid, or unsigned (possibly forged).
    eventProblems: events.filter((e) => PROBLEM_OUTCOMES.includes(e.outcome)).length,
    credits: { purchased: kind("purchase"), granted: kind("grant"), spent: -kind("spend"), refunded: kind("refund"), outstanding: Number(bal?.total ?? 0) },
    asOf: now.toISOString(),
  };
}

// --- Abuse signals --------------------------------------------------------------------------------

/**
 * Workspaces worth a look, from signals we already have (no AI): many failed or refused posts,
 * repeated "sounds like the team" or unverified-fact warnings, AI spend far above what they pay,
 * and several new accounts from one IP address. Signals, not verdicts: a person decides.
 */
export async function abuseSignals(db: Db, now = new Date()) {
  const since7 = new Date(now.getTime() - 7 * DAY);
  const failed = await db
    .select({ orgId: draft.orgId, n: sql<number>`count(*)` })
    .from(draft)
    .where(and(eq(draft.status, "failed"), gte(draft.updatedAt, since7)))
    .groupBy(draft.orgId);
  const flagged = await db
    .select({ orgId: draft.orgId, n: sql<number>`count(*)` })
    .from(draft)
    .where(and(gte(draft.createdAt, since7), sql`(${draft.issues} LIKE '%"sounds_like_team"%' OR ${draft.issues} LIKE '%"unverified_fact"%')`))
    .groupBy(draft.orgId);
  // Several accounts made from one IP address in the last week (by their first session).
  const firstSessions = await db
    .select({ userId: session.userId, ip: session.ipAddress, at: sql<number>`min(${session.createdAt})` })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(and(gte(user.createdAt, since7), isNotNull(session.ipAddress)))
    .groupBy(session.userId);
  const byIp = new Map<string, number>();
  for (const s of firstSessions) if (s.ip) byIp.set(s.ip, (byIp.get(s.ip) ?? 0) + 1);
  const busyIps = [...byIp.entries()].filter(([, n]) => n >= 3).map(([ip, n]) => ({ ip: ip.replace(/(\.\d+|:[0-9a-f]*)$/i, ".x"), accounts: n }));

  const signals = new Map<string, { failed: number; flagged: number }>();
  for (const f of failed) signals.set(f.orgId, { failed: Number(f.n), flagged: 0 });
  for (const f of flagged) signals.set(f.orgId, { failed: signals.get(f.orgId)?.failed ?? 0, flagged: Number(f.n) });
  const out = [];
  for (const [orgId, s] of signals) {
    const reasons: string[] = [];
    if (s.failed >= 10) reasons.push(`${s.failed} failed or refused posts this week`);
    if (s.flagged >= 5) reasons.push(`${s.flagged} posts flagged (team wording or unverified facts) this week`);
    const costUsd = await aiCostFor(db, orgId, now);
    const [sub] = await db.select({ plan: subscription.plan, interval: subscription.interval, seats: subscription.seats, status: subscription.status }).from(subscription).where(eq(subscription.orgId, orgId));
    const cents = sub && sub.status !== "expired" ? planPriceCents(sub.plan, sub.interval, sub.seats ?? undefined) ?? 0 : 0;
    const paysUsd = (sub?.interval === "year" ? cents / 12 : cents) / 100;
    if (costUsd > Math.max(1, paysUsd * 2)) reasons.push(`AI spend $${costUsd.toFixed(2)} in 30 days against $${paysUsd.toFixed(2)} a month`);
    if (!reasons.length) continue;
    const [o] = await db.select({ name: org.name, pausedAt: org.pausedAt, pausedReason: org.pausedReason }).from(org).where(eq(org.id, orgId));
    out.push({ orgId, name: o?.name ?? orgId, reasons, pausedAt: o?.pausedAt?.toISOString() ?? null, pausedReason: o?.pausedReason ?? null });
  }
  const paused = await db.select({ orgId: org.id, name: org.name, pausedAt: org.pausedAt, pausedReason: org.pausedReason, pausedBy: org.pausedBy }).from(org).where(isNotNull(org.pausedAt));
  return { workspaces: out, busyIps, paused: paused.map((p) => ({ ...p, pausedAt: p.pausedAt!.toISOString() })) };
}

// --- Pause / Resume (reversible) -------------------------------------------------------------------

export class PauseError extends Error {
  constructor(
    readonly code: "invalid" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "PauseError";
  }
}

/** Pauses a workspace's automation and publishing, with a reason. Nothing is deleted; scheduled posts wait. */
export async function pauseWorkspace(db: Db, orgId: string, input: { reason: string; by: string }) {
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 300) throw new PauseError("invalid", "Give a reason (5 to 300 characters).");
  const rows = await db.update(org).set({ pausedAt: new Date(), pausedReason: reason, pausedBy: input.by }).where(and(eq(org.id, orgId), isNull(org.pausedAt))).returning({ id: org.id });
  if (rows.length) return true;
  const [exists] = await db.select({ id: org.id }).from(org).where(eq(org.id, orgId));
  throw exists ? new PauseError("conflict", "This workspace is already paused.") : new PauseError("not_found", "No such workspace.");
}

export async function resumeWorkspace(db: Db, orgId: string) {
  const rows = await db.update(org).set({ pausedAt: null, pausedReason: null, pausedBy: null }).where(and(eq(org.id, orgId), isNotNull(org.pausedAt))).returning({ id: org.id });
  if (rows.length) return true;
  const [exists] = await db.select({ id: org.id }).from(org).where(eq(org.id, orgId));
  throw exists ? new PauseError("conflict", "This workspace isn't paused.") : new PauseError("not_found", "No such workspace.");
}

export async function isPaused(db: Db, orgId: string) {
  const [row] = await db.select({ at: org.pausedAt }).from(org).where(eq(org.id, orgId));
  return Boolean(row?.at);
}
