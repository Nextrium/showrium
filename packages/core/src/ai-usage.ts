// What AI costs us: one row per AI call (see `aiUsage` in the schema), and the admin app's cost report.
// Recording never fails the request it belongs to: a cost row is bookkeeping, not the product.
import { and, eq, gte, sql } from "drizzle-orm";
import { aiUsage, brief, draft, insight, org, platformUsage, subscription, type AiFeature, type Db } from "@nextrium/db";
import { planPriceCents } from "./billing.js";
import { newId } from "./ids.js";

const DAY = 86_400_000;

/**
 * Estimates for Workers AI calls, which don't return a price (micro US dollars, Cloudflare's published
 * rates as of October 2026). Marked `estimated` in the ledger. Re-check when Cloudflare changes pricing.
 * - image: FLUX.1 schnell, 1024x1024 (4 tiles) at 6 steps, about $0.00085
 * - transcription: Whisper large v3 turbo, about $0.0005 per audio minute (150 spoken words a minute)
 * - narration: MeloTTS, about $0.0002 per audio minute (900 characters a minute)
 * - photo: reading a photo with a vision model, about $0.0005
 */
export const AI_ESTIMATES = { image: 850, transcriptionPerMinute: 500, narrationPerMinute: 200, photo: 500 };
export const estimateTranscription = (text: string) => Math.max(1, Math.ceil((text.split(/\s+/).filter(Boolean).length / 150) * AI_ESTIMATES.transcriptionPerMinute));
export const estimateNarration = (text: string) => Math.max(1, Math.ceil((text.length / 900) * AI_ESTIMATES.narrationPerMinute));

export type AiUsageRow = { orgId: string; feature: AiFeature; model: string; costMicroUsd: number; estimated?: boolean; refId?: string | null };

/** Records AI calls. Never throws: a failed cost row is logged, and the request carries on. */
export async function recordAiUsage(db: Db, rows: AiUsageRow[]) {
  const values = rows.filter((r) => r.costMicroUsd >= 0).map((r) => ({ id: newId("aiu"), orgId: r.orgId, feature: r.feature, model: r.model.slice(0, 120), costMicroUsd: Math.round(r.costMicroUsd), estimated: Boolean(r.estimated), refId: r.refId ?? null }));
  if (!values.length) return;
  try {
    await db.insert(aiUsage).values(values).onConflictDoNothing();
  } catch (error) {
    console.warn("ai usage not recorded", error instanceof Error ? error.message : error);
  }
}

/**
 * Cron: copies costs recorded before the ledger existed (posts written, insights) into it, once
 * each (the feature and id pair is unique). A few hundred per run; nothing to do once caught up.
 */
export async function backfillAiUsage(db: Db, limit = 300) {
  const briefs = await db
    .select({ id: brief.id, orgId: brief.orgId, model: brief.model, cost: brief.costMicroUsd, at: brief.createdAt })
    .from(brief)
    .where(sql`NOT EXISTS (SELECT 1 FROM ai_usage u WHERE u.ref_id = ${brief.id})`)
    .limit(limit);
  const insights = await db
    .select({ id: insight.id, orgId: insight.orgId, model: insight.model, cost: insight.costMicroUsd, at: insight.createdAt })
    .from(insight)
    .where(sql`NOT EXISTS (SELECT 1 FROM ai_usage u WHERE u.ref_id = ${insight.id})`)
    .limit(limit);
  const rows = [
    ...briefs.map((b) => ({ id: newId("aiu"), orgId: b.orgId, feature: "write" as const, model: b.model, costMicroUsd: b.cost, estimated: false, refId: b.id, createdAt: b.at })),
    ...insights.map((i) => ({ id: newId("aiu"), orgId: i.orgId, feature: "insights" as const, model: i.model, costMicroUsd: i.cost, estimated: false, refId: i.id, createdAt: i.at })),
  ];
  for (let i = 0; i < rows.length; i += 10) await db.insert(aiUsage).values(rows.slice(i, i + 10)).onConflictDoNothing();
  return rows.length;
}

/** A workspace that pays nothing is only flagged once its AI use passes this in 30 days (pennies are normal). */
export const FREE_COST_FLAG_USD = 1;
const usd = (micro: number) => Math.round(micro) / 1_000_000;

/**
 * The admin app's AI cost report: this month and the last 30 days, by day, feature and model, the
 * cost of writing one post, the workspaces that cost most (AI plus X) against what they pay, and X API spend.
 */
export async function aiCostReport(db: Db, now = new Date()) {
  const since30 = new Date(now.getTime() - 30 * DAY);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rows = await db
    .select({ orgId: aiUsage.orgId, feature: aiUsage.feature, model: aiUsage.model, micro: aiUsage.costMicroUsd, estimated: aiUsage.estimated, at: aiUsage.createdAt })
    .from(aiUsage)
    .where(gte(aiUsage.createdAt, since30 < monthStart ? since30 : monthStart));
  const last30 = rows.filter((r) => r.at >= since30);
  const sum = (list: typeof rows) => list.reduce((a, r) => a + r.micro, 0);

  const byDay = new Map<string, number>();
  for (let i = 29; i >= 0; i--) byDay.set(new Date(now.getTime() - i * DAY).toISOString().slice(0, 10), 0);
  for (const r of last30) {
    const k = r.at.toISOString().slice(0, 10);
    if (byDay.has(k)) byDay.set(k, byDay.get(k)! + r.micro);
  }
  const group = (key: "feature" | "model") => {
    const m = new Map<string, { micro: number; calls: number }>();
    for (const r of last30) {
      const g = m.get(r[key]) ?? { micro: 0, calls: 0 };
      g.micro += r.micro;
      g.calls += 1;
      m.set(r[key], g);
    }
    return [...m.entries()].map(([name, g]) => ({ name, usd: usd(g.micro), calls: g.calls })).sort((a, b) => b.usd - a.usd);
  };

  // Writing one post: the cost of writing (brief) divided by the posts written in the period.
  const [written] = await db.select({ n: sql<number>`count(*)` }).from(draft).where(gte(draft.createdAt, since30));
  const writeMicro = sum(last30.filter((r) => r.feature === "write" || r.feature === "research"));
  const posts30 = Number(written?.n ?? 0);

  // The workspaces that cost most, against what they pay a month (yearly plans divided by 12).
  // Platform API costs (X), from the ledger of paid calls that went out.
  const xRows = await db
    .select({ orgId: platformUsage.orgId, kind: platformUsage.kind, micro: platformUsage.costMicroUsd, at: platformUsage.createdAt })
    .from(platformUsage)
    .where(gte(platformUsage.createdAt, since30 < monthStart ? since30 : monthStart));
  const x30 = xRows.filter((r) => r.at >= since30);
  const xPerOrg = new Map<string, number>();
  for (const r of x30) xPerOrg.set(r.orgId, (xPerOrg.get(r.orgId) ?? 0) + r.micro);

  const perOrg = new Map<string, number>();
  for (const r of last30) perOrg.set(r.orgId, (perOrg.get(r.orgId) ?? 0) + r.micro);
  for (const [orgId, micro] of xPerOrg) perOrg.set(orgId, (perOrg.get(orgId) ?? 0) + micro);
  const top = [...perOrg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const workspaces = [];
  for (const [orgId, micro] of top) {
    const [o] = await db.select({ name: org.name, plan: org.plan, fullAccess: org.fullAccess, seats: org.seats }).from(org).where(eq(org.id, orgId));
    const [sub] = await db.select({ plan: subscription.plan, interval: subscription.interval, seats: subscription.seats, status: subscription.status }).from(subscription).where(eq(subscription.orgId, orgId));
    const cents = sub && sub.status !== "expired" ? planPriceCents(sub.plan, sub.interval, sub.seats ?? undefined) : null;
    const paysUsd = cents === null ? 0 : (sub!.interval === "year" ? cents / 12 : cents) / 100;
    workspaces.push({ orgId, name: o?.name ?? orgId, plan: o?.fullAccess ? "staff" : (o?.plan ?? "free"), costUsd: usd(micro), xUsd: usd(xPerOrg.get(orgId) ?? 0), paysUsd: Math.round(paysUsd * 100) / 100, losing: paysUsd > 0 ? usd(micro) > paysUsd : usd(micro) >= FREE_COST_FLAG_USD });
  }

  return {
    monthToDateUsd: usd(sum(rows.filter((r) => r.at >= monthStart))),
    last30Usd: usd(sum(last30)),
    estimatedShare: last30.length ? Math.round((sum(last30.filter((r) => r.estimated)) / Math.max(1, sum(last30))) * 100) : 0,
    byDay: [...byDay.entries()].map(([date, micro]) => ({ date, usd: usd(micro) })),
    byFeature: group("feature"),
    byModel: group("model"),
    perPost: { posts: posts30, usd: posts30 ? usd(writeMicro / posts30) : 0 },
    workspaces,
    xApi: {
      monthToDateUsd: usd(xRows.filter((r) => r.at >= monthStart).reduce((a, r) => a + r.micro, 0)),
      last30Usd: usd(x30.reduce((a, r) => a + r.micro, 0)),
      posts: x30.filter((r) => r.kind === "post" || r.kind === "post_with_link").length,
      images: x30.filter((r) => r.kind === "image_description").length,
      reads: x30.filter((r) => r.kind === "post_read" || r.kind === "user_read").length,
    },
  };
}

/** One workspace's AI spend over the last 30 days (for the user detail page and abuse signals). */
export async function aiCostFor(db: Db, orgId: string, now = new Date()) {
  const [row] = await db
    .select({ micro: sql<number>`coalesce(sum(${aiUsage.costMicroUsd}), 0)` })
    .from(aiUsage)
    .where(and(eq(aiUsage.orgId, orgId), gte(aiUsage.createdAt, new Date(now.getTime() - 30 * DAY))));
  return usd(Number(row?.micro ?? 0));
}


/**
 * What one workspace's use has cost us this month (UTC): AI by feature and X API calls. Shown to the
 * workspace in Billing & usage, for transparency. These are our costs, not charges to them.
 */
export async function workspaceCosts(db: Db, orgId: string, now = new Date()) {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const ai = await db
    .select({ feature: aiUsage.feature, micro: sql<number>`sum(${aiUsage.costMicroUsd})`, calls: sql<number>`count(*)`, estimated: sql<number>`max(${aiUsage.estimated})` })
    .from(aiUsage)
    .where(and(eq(aiUsage.orgId, orgId), gte(aiUsage.createdAt, monthStart)))
    .groupBy(aiUsage.feature);
  const xs = await db
    .select({ kind: platformUsage.kind, micro: sql<number>`sum(${platformUsage.costMicroUsd})`, calls: sql<number>`count(*)` })
    .from(platformUsage)
    .where(and(eq(platformUsage.orgId, orgId), gte(platformUsage.createdAt, monthStart)))
    .groupBy(platformUsage.kind);
  const aiMicro = ai.reduce((a, r) => a + Number(r.micro), 0);
  const xMicro = xs.reduce((a, r) => a + Number(r.micro), 0);
  const xCalls = (k: string) => Number(xs.find((r) => r.kind === k)?.calls ?? 0);
  return {
    since: monthStart.toISOString(),
    totalUsd: usd(aiMicro + xMicro),
    ai: {
      usd: usd(aiMicro),
      byFeature: ai.map((r) => ({ feature: r.feature, usd: usd(Number(r.micro)), calls: Number(r.calls), estimated: Boolean(Number(r.estimated)) })).sort((a, b) => b.usd - a.usd),
    },
    x: { usd: usd(xMicro), posts: xCalls("post") + xCalls("post_with_link"), images: xCalls("image_description"), reads: xCalls("post_read") + xCalls("user_read") },
  };
}
