// Phase 5: autonomy and learning. Ideas from sources, autopilot, the engagement listener,
// audience insights and analytics. Every function filters by orgId (tenant isolation lives here).
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  autopilot,
  brief,
  connection,
  contextItem,
  draft,
  engagement,
  idea,
  insight,
  persona,
  postMetrics,
  source,
  type AutopilotLevel,
  type ContentMode,
  type Db,
  type Platform,
} from "@nextrium/db";
import { generateStructured, insightSystemPrompt, insightUserPrompt, InsightSchema, type Provider } from "@nextrium/llm";
import { blueskyEngagement, mastodonEngagement, type FetchLike, type PostEngagement } from "@nextrium/platforms";
import { addContextItems, compose, getOrgPlan, markSourceChecked, updateDraft } from "./content.js";
import { allowedAutopilotLevel, getUsage, PLAN_FEATURES, PLAN_LIMITS } from "./plans.js";
import { chunkRows } from "./chunk.js";
import { newId } from "./ids.js";
import { ingestFeed, ingestGithubActivity } from "./ingest.js";
import { recordAudit } from "./orgs.js";
import { API_PUBLISH_PLATFORMS, scheduleDraft } from "./publishing.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// --- Sources -> ideas ------------------------------------------------------------------

/** Cheap, deterministic scoring (no AI): releases and launches rank above ordinary articles. */
export function scoreIdea(kind: string, title: string): { score: number; reason: string } {
  let score = kind === "github_release" ? 70 : kind === "github_activity" ? 60 : kind === "rss_item" ? 50 : 40;
  if (/\bv?\d+\.\d+(\.\d+)?\b/.test(title)) score += 10;
  if (/\b(launch|launched|release|released|ship|shipped|announce|introducing|new)\b/i.test(title)) score += 10;
  const what = kind === "github_release" ? "New release" : kind === "github_activity" ? "Your work" : kind === "rss_item" ? "New article" : "New material";
  return { score: Math.min(100, score), reason: `${what}: ${title || "untitled"}`.slice(0, 200) };
}

export async function createIdeas(db: Db, orgId: string, kind: string, items: { id: string; title: string }[]) {
  if (!items.length) return 0;
  // Sources list newest first; a small step down per position keeps that order among equal scores.
  const rows = items.map((i, n) => {
    const { score, reason } = scoreIdea(kind, i.title);
    return { id: newId("idea"), orgId, contextItemId: i.id, reason, score: Math.max(0, score - Math.min(n, 9)) };
  });
  let added = 0;
  for (const part of chunkRows(rows, 6)) {
    added += (await db.insert(idea).values(part).onConflictDoNothing({ target: [idea.orgId, idea.contextItemId] }).returning({ id: idea.id })).length;
  }
  return added;
}

/** Fetches one source, stores new items and turns them into ideas. Used by "Sync now" and the cron job. */
export async function syncSource(
  db: Db,
  src: typeof source.$inferSelect,
  opts: { fetch?: FetchLike | undefined; now?: Date } = {},
): Promise<{ added: number; ideas: number; error: string | null }> {
  try {
    const batches: { kind: "github_release" | "github_activity" | "rss_item"; items: Awaited<ReturnType<typeof ingestFeed>> }[] = [];
    if (src.kind === "github_repo") {
      const gh = await ingestGithubActivity(src.key, { fetch: opts.fetch, ...(opts.now ? { now: opts.now } : {}) });
      batches.push({ kind: "github_release", items: gh.releases }, { kind: "github_activity", items: gh.activity });
    } else {
      batches.push({ kind: "rss_item", items: await ingestFeed(src.key, opts.fetch) });
    }
    let added = 0;
    let ideas = 0;
    for (const b of batches) {
      const rows = await addContextItems(db, src.orgId, b.kind, b.items, src.id);
      added += rows.length;
      ideas += await createIdeas(db, src.orgId, b.kind, rows);
    }
    await markSourceChecked(db, src.orgId, src.id, null);
    return { added, ideas, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "Sync failed.";
    await markSourceChecked(db, src.orgId, src.id, message);
    return { added: 0, ideas: 0, error: message };
  }
}

/** Cron: checks the sources that have waited longest (at most every 6 hours each). */
export async function runSourcePolling(db: Db, opts: { fetch?: FetchLike | undefined } = {}, now = new Date(), limit = 2) {
  const due = await db
    .select()
    .from(source)
    .where(or(isNull(source.lastCheckedAt), lt(source.lastCheckedAt, new Date(now.getTime() - 6 * HOUR))))
    .orderBy(asc(source.lastCheckedAt))
    .limit(limit);
  let ideas = 0;
  for (const src of due) ideas += (await syncSource(db, src, opts)).ideas;
  return { checked: due.length, ideas };
}

export async function listIdeas(db: Db, orgId: string, status: "new" | "drafted" | "dismissed" = "new") {
  return db
    .select({
      id: idea.id,
      reason: idea.reason,
      score: idea.score,
      status: idea.status,
      createdAt: idea.createdAt,
      contextItemId: idea.contextItemId,
      title: contextItem.title,
      body: sql<string>`substr(${contextItem.body}, 1, 400)`,
      url: contextItem.url,
    })
    .from(idea)
    .innerJoin(contextItem, eq(contextItem.id, idea.contextItemId))
    .where(and(eq(idea.orgId, orgId), eq(idea.status, status)))
    .orderBy(desc(idea.score), desc(idea.createdAt))
    .limit(50);
}

export async function dismissIdea(db: Db, orgId: string, id: string) {
  const rows = await db.update(idea).set({ status: "dismissed" }).where(and(eq(idea.orgId, orgId), eq(idea.id, id), eq(idea.status, "new"))).returning({ id: idea.id });
  return rows.length > 0;
}

export class IdeaError extends Error {
  constructor(
    readonly code: "not_found" | "idea_used",
    message: string,
  ) {
    super(message);
    this.name = "IdeaError";
  }
}

/** Writes posts from an idea. The idea is claimed first, so two clicks (or the cron) can't draft it twice. */
export async function composeIdea(db: Db, providers: Provider[], input: { orgId: string; ideaId: string; mode: ContentMode; platforms: Platform[] }) {
  const [claimed] = await db
    .update(idea)
    .set({ status: "drafted", draftedAt: new Date() })
    .where(and(eq(idea.orgId, input.orgId), eq(idea.id, input.ideaId), eq(idea.status, "new")))
    .returning({ contextItemId: idea.contextItemId });
  if (!claimed) {
    const [exists] = await db.select({ id: idea.id }).from(idea).where(and(eq(idea.orgId, input.orgId), eq(idea.id, input.ideaId)));
    throw exists ? new IdeaError("idea_used", "This idea was already used or dismissed.") : new IdeaError("not_found", "No such idea in this workspace.");
  }
  try {
    return await compose(db, providers, { orgId: input.orgId, contextItemId: claimed.contextItemId, mode: input.mode, platforms: input.platforms });
  } catch (error) {
    await db.update(idea).set({ status: "new", draftedAt: null }).where(eq(idea.id, input.ideaId));
    throw error;
  }
}

// --- Autopilot -----------------------------------------------------------------------

export type AutopilotSettings = { level: AutopilotLevel; mode: ContentMode; platforms: Platform[]; postsPerWeek: number; publishHourUtc: number };
const DEFAULTS: AutopilotSettings = { level: "coach", mode: "build_in_public", platforms: [], postsPerWeek: 3, publishHourUtc: 14 };

export async function getAutopilot(db: Db, orgId: string) {
  const [row] = await db.select().from(autopilot).where(eq(autopilot.orgId, orgId));
  return row ? { level: row.level, mode: row.mode, platforms: row.platforms, postsPerWeek: row.postsPerWeek, publishHourUtc: row.publishHourUtc, lastRunAt: row.lastRunAt } : { ...DEFAULTS, lastRunAt: null };
}

export class AutopilotError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "plan_required" = "invalid",
  ) {
    super(message);
    this.name = "AutopilotError";
  }
}

export async function saveAutopilot(db: Db, orgId: string, s: AutopilotSettings) {
  const [p] = await db.select({ safe: persona.monetizationSafe, platforms: persona.platforms }).from(persona).where(eq(persona.orgId, orgId));
  if (s.level !== "coach") {
    if (!p) throw new AutopilotError("Set up your voice first.");
    if (!s.platforms.length) throw new AutopilotError("Choose at least one platform for autopilot.");
    const outside = s.platforms.filter((x) => !p.platforms.includes(x));
    if (outside.length) throw new AutopilotError(`Add ${outside.join(", ")} to your platforms in Voice first.`);
  }
  const plan = await getOrgPlan(db, orgId);
  if (allowedAutopilotLevel(plan, s.level) !== s.level) {
    throw new AutopilotError(`The ${plan} plan includes up to "${PLAN_FEATURES[plan].autopilot}". Upgrade for more.`, "plan_required");
  }
  if (s.level === "autopilot" && p?.safe) throw new AutopilotError("Monetization-safe mode needs your approval on every post, so full autopilot is off. Use batch approval instead.");
  const values = { ...s, postsPerWeek: Math.min(14, Math.max(1, Math.round(s.postsPerWeek))), publishHourUtc: Math.min(23, Math.max(0, Math.round(s.publishHourUtc))) };
  await db.insert(autopilot).values({ orgId, ...values }).onConflictDoUpdate({ target: autopilot.orgId, set: { ...values, updatedAt: new Date() } });
  return getAutopilot(db, orgId);
}

/** The next posting slot at the chosen hour, at least 2 hours away so the user can still cancel. */
export function nextSlot(now: Date, hourUtc: number): Date {
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc));
  while (slot.getTime() < now.getTime() + 2 * HOUR) slot.setUTCDate(slot.getUTCDate() + 1);
  return slot;
}

/** Platforms autopilot never posts to by itself. X: paid API per post and strict automation rules. */
export const AUTOPILOT_EXCLUDED: Platform[] = ["x"];

export async function runAutopilotFor(db: Db, providers: Provider[], orgId: string, now = new Date()) {
  const saved = await getAutopilot(db, orgId);
  const plan = await getOrgPlan(db, orgId);
  // A downgraded plan caps the level without changing the saved setting.
  const s = { ...saved, level: allowedAutopilotLevel(plan, saved.level) };
  if (s.level === "coach") return { skipped: "coach" as const };
  const [p] = await db.select({ safe: persona.monetizationSafe, platforms: persona.platforms }).from(persona).where(eq(persona.orgId, orgId));
  if (!p) return { skipped: "no_persona" as const };
  const platforms = s.platforms.filter((x) => p.platforms.includes(x));
  if (!platforms.length) return { skipped: "no_platforms" as const };

  const [week] = await db
    .select({ n: sql<number>`count(*)` })
    .from(idea)
    .where(and(eq(idea.orgId, orgId), eq(idea.status, "drafted"), gte(idea.draftedAt, new Date(now.getTime() - 7 * DAY))));
  if ((week?.n ?? 0) >= s.postsPerWeek) return { skipped: "weekly_limit" as const };

  // Autopilot spends only the plan's monthly allowance, never credits.
  if ((await getUsage(db, orgId)).postsGenerated + platforms.length > PLAN_LIMITS[plan].posts) return { skipped: "plan_allowance" as const };

  const [best] = await db
    .select({ id: idea.id, kind: contextItem.kind })
    .from(idea)
    .innerJoin(contextItem, eq(contextItem.id, idea.contextItemId))
    .where(and(eq(idea.orgId, orgId), eq(idea.status, "new"), gte(idea.createdAt, new Date(now.getTime() - 30 * DAY))))
    .orderBy(desc(idea.score), desc(idea.createdAt))
    .limit(1);
  if (!best) return { skipped: "no_ideas" as const };

  const out = await composeIdea(db, providers, { orgId, ideaId: best.id, mode: s.mode, platforms });
  let scheduled = 0;
  // Full autopilot schedules only clean posts (no errors, no warnings) to connected accounts.
  // Everything else waits in Drafts for the user. Replies are never automated.
  // Ideas from audience comments are shaped by strangers' text, so they always wait for the user.
  if (s.level === "autopilot" && !p.safe && (best.kind === "github_release" || best.kind === "github_activity" || best.kind === "rss_item")) {
    const conns = await db
      .select({ id: connection.id, platform: connection.platform })
      .from(connection)
      .where(and(eq(connection.orgId, orgId), eq(connection.status, "active")));
    for (const d of out.drafts) {
      if (d.issues.length || AUTOPILOT_EXCLUDED.includes(d.platform)) continue;
      const conn = conns.find((c) => c.platform === d.platform && API_PUBLISH_PLATFORMS.includes(c.platform));
      if (!conn) continue;
      await updateDraft(db, orgId, d.id, { status: "approved" });
      await scheduleDraft(db, orgId, d.id, { at: nextSlot(now, s.publishHourUtc), connectionId: conn.id });
      scheduled++;
    }
  }
  await recordAudit(db, { orgId, actorUserId: null, action: "autopilot.run", target: best.id, meta: { level: s.level, drafts: out.drafts.length, scheduled } });
  return { ideaId: best.id, drafts: out.drafts.length, scheduled };
}

/** Cron: runs autopilot for workspaces that haven't run in the last 20 hours (once a day each). */
export async function runAutopilot(db: Db, providers: Provider[], now = new Date(), limit = 1) {
  if (!providers.length) return { ran: 0 };
  const cutoff = new Date(now.getTime() - 20 * HOUR);
  const due = await db
    .select({ orgId: autopilot.orgId })
    .from(autopilot)
    .where(and(ne(autopilot.level, "coach"), or(isNull(autopilot.lastRunAt), lt(autopilot.lastRunAt, cutoff))))
    .orderBy(asc(autopilot.lastRunAt))
    .limit(limit);
  let ran = 0;
  for (const { orgId } of due) {
    // Claim the run so overlapping cron invocations can't both run one workspace.
    const [claimed] = await db
      .update(autopilot)
      .set({ lastRunAt: now })
      .where(and(eq(autopilot.orgId, orgId), or(isNull(autopilot.lastRunAt), lt(autopilot.lastRunAt, cutoff))))
      .returning({ orgId: autopilot.orgId });
    if (!claimed) continue;
    try {
      await runAutopilotFor(db, providers, orgId, now);
      ran++;
    } catch (error) {
      console.warn("autopilot run failed", { orgId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ran };
}

// --- Engagement listener ------------------------------------------------------------------

export const LISTENED_PLATFORMS = ["bluesky", "mastodon"] as const;

async function saveEngagement(db: Db, orgId: string, d: { id: string; platform: Platform }, e: PostEngagement, now: Date) {
  await db
    .insert(postMetrics)
    .values({ draftId: d.id, orgId, likes: e.likes, replies: e.replies, reposts: e.reposts, checkedAt: now })
    .onConflictDoUpdate({ target: postMetrics.draftId, set: { likes: e.likes, replies: e.replies, reposts: e.reposts, checkedAt: now } });
  if (!e.comments.length) return 0;
  const rows = e.comments.map((c) => ({ id: newId("eng"), orgId, draftId: d.id, platform: d.platform, origin: "api" as const, externalId: c.externalId, author: c.author.slice(0, 100), text: c.text }));
  let added = 0;
  for (const part of chunkRows(rows, 8)) {
    added += (await db.insert(engagement).values(part).onConflictDoNothing({ target: [engagement.orgId, engagement.externalId] }).returning({ id: engagement.id })).length;
  }
  return added;
}

async function readEngagement(d: { platform: string; externalPostId: string | null; meta: Record<string, string> | null }, doFetch: FetchLike) {
  if (!d.externalPostId) return null;
  if (d.platform === "bluesky") return blueskyEngagement(d.externalPostId, doFetch);
  if (d.platform === "mastodon" && d.meta?.instance) return mastodonEngagement(d.meta.instance, d.externalPostId, doFetch);
  return null;
}

const listenable = (orgId: string | null, now: Date) =>
  and(
    ...(orgId ? [eq(draft.orgId, orgId)] : []),
    eq(draft.status, "published"),
    eq(draft.publishMethod, "api"),
    inArray(draft.platform, [...LISTENED_PLATFORMS]),
    isNotNull(draft.externalPostId),
    gte(draft.publishedAt, new Date(now.getTime() - 14 * DAY)),
  );

/** Cron: refreshes replies and counts for recent API-published Bluesky and Mastodon posts (every 3 hours each). */
export async function runEngagementSync(db: Db, doFetch: FetchLike = fetch, now = new Date(), limit = 5) {
  const due = await db
    .select({ id: draft.id, orgId: draft.orgId, platform: draft.platform, externalPostId: draft.externalPostId, meta: connection.meta })
    .from(draft)
    .leftJoin(postMetrics, eq(postMetrics.draftId, draft.id))
    .leftJoin(connection, and(eq(connection.id, draft.connectionId), eq(connection.orgId, draft.orgId)))
    .where(and(listenable(null, now), or(isNull(postMetrics.checkedAt), lt(postMetrics.checkedAt, new Date(now.getTime() - 3 * HOUR)))))
    .orderBy(asc(postMetrics.checkedAt))
    .limit(limit);
  let comments = 0;
  for (const d of due) {
    try {
      const e = await readEngagement(d, doFetch);
      if (e) comments += await saveEngagement(db, d.orgId, d, e, now);
    } catch (error) {
      // Mark as checked anyway so one broken post doesn't block the queue.
      await db.insert(postMetrics).values({ draftId: d.id, orgId: d.orgId, checkedAt: now }).onConflictDoUpdate({ target: postMetrics.draftId, set: { checkedAt: now } });
      console.warn("engagement sync failed", { draftId: d.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { checked: due.length, comments };
}

export class EngagementError extends Error {
  constructor(
    readonly code: "not_found" | "not_published" | "not_supported" | "too_soon",
    message: string,
  ) {
    super(message);
    this.name = "EngagementError";
  }
}

/** "Check now" for one post (at most every 10 minutes). */
export async function refreshPostEngagement(db: Db, orgId: string, draftId: string, doFetch: FetchLike = fetch, now = new Date()) {
  const [d] = await db
    .select({ id: draft.id, platform: draft.platform, status: draft.status, externalPostId: draft.externalPostId, meta: connection.meta, checkedAt: postMetrics.checkedAt })
    .from(draft)
    .leftJoin(postMetrics, eq(postMetrics.draftId, draft.id))
    .leftJoin(connection, and(eq(connection.id, draft.connectionId), eq(connection.orgId, draft.orgId)))
    .where(and(eq(draft.orgId, orgId), eq(draft.id, draftId)));
  if (!d) throw new EngagementError("not_found", "No such post in this workspace.");
  if (d.status !== "published") throw new EngagementError("not_published", "Only published posts have replies.");
  if (!LISTENED_PLATFORMS.includes(d.platform as (typeof LISTENED_PLATFORMS)[number]) || !d.externalPostId) {
    throw new EngagementError("not_supported", "This platform doesn't let apps read replies. Paste the comments instead.");
  }
  if (d.checkedAt && d.checkedAt.getTime() > now.getTime() - 10 * 60_000) throw new EngagementError("too_soon", "Checked in the last 10 minutes. Try again shortly.");
  const e = await readEngagement(d, doFetch);
  if (!e) throw new EngagementError("not_supported", "This post can't be read automatically.");
  const added = await saveEngagement(db, orgId, d, e, now);
  return { likes: e.likes, replies: e.replies, reposts: e.reposts, added };
}

/** Comments the user pasted (LinkedIn, X, TikTok and others that don't allow reading), plus optional counts. */
export async function addManualEngagement(
  db: Db,
  orgId: string,
  draftId: string,
  input: { comments: string[]; likes?: number | undefined; replies?: number | undefined; reposts?: number | undefined },
  now = new Date(),
) {
  const [d] = await db.select({ id: draft.id, platform: draft.platform, status: draft.status }).from(draft).where(and(eq(draft.orgId, orgId), eq(draft.id, draftId)));
  if (!d) throw new EngagementError("not_found", "No such post in this workspace.");
  if (d.status !== "published") throw new EngagementError("not_published", "Mark the post as published first.");
  const comments = input.comments.map((c) => c.trim()).filter(Boolean).slice(0, 50);
  if (comments.length) {
    const [today] = await db
      .select({ n: sql<number>`count(*)` })
      .from(engagement)
      .where(and(eq(engagement.orgId, orgId), eq(engagement.origin, "manual"), gte(engagement.createdAt, new Date(now.getTime() - DAY))));
    if ((today?.n ?? 0) + comments.length > 500) throw new EngagementError("too_soon", "That's a lot of comments for one day. Add more tomorrow.");
    const rows = comments.map((text) => ({ id: newId("eng"), orgId, draftId, platform: d.platform, origin: "manual" as const, text: text.slice(0, 2000) }));
    for (const part of chunkRows(rows, 8)) await db.insert(engagement).values(part);
  }
  if (input.likes !== undefined || input.replies !== undefined || input.reposts !== undefined) {
    const set = { likes: input.likes ?? 0, replies: input.replies ?? 0, reposts: input.reposts ?? 0, checkedAt: now };
    await db.insert(postMetrics).values({ draftId, orgId, ...set }).onConflictDoUpdate({ target: postMetrics.draftId, set });
  }
  return { added: comments.length };
}

export async function listEngagement(db: Db, orgId: string, limit = 100) {
  return db
    .select({ id: engagement.id, draftId: engagement.draftId, platform: engagement.platform, origin: engagement.origin, author: engagement.author, text: engagement.text, createdAt: engagement.createdAt })
    .from(engagement)
    .where(eq(engagement.orgId, orgId))
    .orderBy(desc(engagement.createdAt))
    .limit(limit);
}

// --- Insights ----------------------------------------------------------------------------

export class InsightError extends Error {
  constructor(
    readonly code: "too_soon" | "not_enough" | "ai_unavailable" | "not_found" | "already_used" | "plan_required",
    message: string,
  ) {
    super(message);
    this.name = "InsightError";
  }
}

export async function latestInsight(db: Db, orgId: string) {
  const [row] = await db.select().from(insight).where(eq(insight.orgId, orgId)).orderBy(desc(insight.createdAt)).limit(1);
  return row ?? null;
}

/** Clusters recent comments into themes (at most once an hour; about $0.0001 per run). */
export async function refreshInsights(db: Db, providers: Provider[], orgId: string, now = new Date()) {
  const plan = await getOrgPlan(db, orgId);
  if (!PLAN_FEATURES[plan].insights) throw new InsightError("plan_required", "Audience themes come with the Starter plan and above.");
  const last = await latestInsight(db, orgId);
  if (last && last.createdAt.getTime() > now.getTime() - HOUR) throw new InsightError("too_soon", "Insights were refreshed in the last hour.");
  const comments = await db
    .select({ text: engagement.text, post: draft.text })
    .from(engagement)
    .innerJoin(draft, eq(draft.id, engagement.draftId))
    .where(and(eq(engagement.orgId, orgId), gte(engagement.createdAt, new Date(now.getTime() - 90 * DAY))))
    .orderBy(desc(engagement.createdAt))
    .limit(150);
  if (comments.length < 3) throw new InsightError("not_enough", "Insights need at least 3 comments. Paste some or wait for replies.");
  if (!providers.length) throw new InsightError("ai_unavailable", "The AI isn't configured here.");
  let result;
  try {
    result = await generateStructured(providers, { system: insightSystemPrompt(), user: insightUserPrompt(comments), maxTokens: 2500 }, InsightSchema);
  } catch {
    throw new InsightError("ai_unavailable", "The AI is busy right now. Please try again in a minute.");
  }
  const themes = result.data.themes.map((t) => ({ ...t, count: Math.min(t.count, comments.length) }));
  const id = newId("ins");
  await db.insert(insight).values({ id, orgId, themes, basedOn: comments.length, model: result.model, costMicroUsd: result.costMicroUsd });
  return latestInsight(db, orgId);
}

/** Turns an audience theme into an idea (and the material to write from). */
export async function ideaFromTheme(db: Db, orgId: string, insightId: string, index: number) {
  const [row] = await db.select().from(insight).where(and(eq(insight.orgId, orgId), eq(insight.id, insightId)));
  const theme = row?.themes[index];
  if (!theme) throw new InsightError("not_found", "No such theme.");
  const body = [theme.suggestion, "", "What people said:", ...theme.examples.map((e) => `- ${e}`)].join("\n");
  const [ctx] = await addContextItems(db, orgId, "manual", [{ externalId: `insight:${insightId}:${index}`, title: `Audience: ${theme.label}`, body, url: null }]);
  if (!ctx) throw new InsightError("already_used", "You already made an idea from this theme.");
  const [created] = await db.insert(idea).values({ id: newId("idea"), orgId, contextItemId: ctx.id, reason: `Your audience: ${theme.label}`.slice(0, 200), score: 90 }).returning({ id: idea.id });
  return created!.id;
}

// --- Analytics ----------------------------------------------------------------------------

const engagementScore = sql<number>`coalesce(${postMetrics.likes}, 0) + 2 * coalesce(${postMetrics.replies}, 0) + coalesce(${postMetrics.reposts}, 0)`;

export async function getAnalytics(db: Db, orgId: string, now = new Date()) {
  const since30 = new Date(now.getTime() - 30 * DAY);
  const since90 = new Date(now.getTime() - 90 * DAY);
  const published = and(eq(draft.orgId, orgId), eq(draft.status, "published"));
  const month = `${now.toISOString().slice(0, 7)}-01T00:00:00Z`;

  const [statuses, platforms, modes, weeks, top, cost, ideas] = await Promise.all([
    db.select({ status: draft.status, n: sql<number>`count(*)` }).from(draft).where(eq(draft.orgId, orgId)).groupBy(draft.status),
    db
      .select({ platform: draft.platform, posts: sql<number>`count(*)`, likes: sql<number>`coalesce(sum(${postMetrics.likes}), 0)`, replies: sql<number>`coalesce(sum(${postMetrics.replies}), 0)`, reposts: sql<number>`coalesce(sum(${postMetrics.reposts}), 0)` })
      .from(draft)
      .leftJoin(postMetrics, eq(postMetrics.draftId, draft.id))
      .where(and(published, gte(draft.publishedAt, since30)))
      .groupBy(draft.platform),
    db
      .select({ mode: brief.mode, posts: sql<number>`count(*)`, score: sql<number>`coalesce(avg(${engagementScore}), 0)` })
      .from(draft)
      .innerJoin(brief, eq(brief.id, draft.briefId))
      .leftJoin(postMetrics, eq(postMetrics.draftId, draft.id))
      .where(and(published, gte(draft.publishedAt, since90)))
      .groupBy(brief.mode),
    db.select({ at: draft.publishedAt }).from(draft).where(and(published, gte(draft.publishedAt, new Date(now.getTime() - 56 * DAY)))).limit(5000),
    db
      .select({ id: draft.id, platform: draft.platform, text: sql<string>`substr(${draft.text}, 1, 140)`, url: draft.externalUrl, score: engagementScore })
      .from(draft)
      .innerJoin(postMetrics, eq(postMetrics.draftId, draft.id))
      .where(and(published, gte(draft.publishedAt, since90)))
      .orderBy(desc(engagementScore))
      .limit(5),
    db.select({ micro: sql<number>`coalesce(sum(${brief.costMicroUsd}), 0)` }).from(brief).where(and(eq(brief.orgId, orgId), gte(brief.createdAt, new Date(month)))),
    db.select({ n: sql<number>`count(*)` }).from(idea).where(and(eq(idea.orgId, orgId), eq(idea.status, "new"))),
  ]);

  // Posts published per week, oldest first (8 weeks).
  const perWeek = Array.from({ length: 8 }, () => 0);
  for (const w of weeks) {
    if (!w.at) continue;
    const ago = Math.floor((now.getTime() - w.at.getTime()) / (7 * DAY));
    if (ago >= 0 && ago < 8) perWeek[7 - ago]!++;
  }
  return {
    statuses: Object.fromEntries(statuses.map((s) => [s.status, Number(s.n)])),
    platforms: platforms.map((p) => ({ platform: p.platform, posts: Number(p.posts), likes: Number(p.likes), replies: Number(p.replies), reposts: Number(p.reposts) })),
    modes: modes.map((m) => ({ mode: m.mode, posts: Number(m.posts), avgScore: Math.round(Number(m.score) * 10) / 10 })),
    perWeek,
    top: top.map((t) => ({ ...t, score: Number(t.score) })),
    aiCostUsdThisMonth: Number(cost[0]?.micro ?? 0) / 1_000_000,
    newIdeas: Number(ideas[0]?.n ?? 0),
  };
}

/** Counts for navigation badges: drafts waiting and new ideas. Cheap (two counts). */
export async function getSummary(db: Db, orgId: string) {
  const [drafts] = await db.select({ n: sql<number>`count(*)` }).from(draft).where(and(eq(draft.orgId, orgId), eq(draft.status, "draft")));
  const [ideas] = await db.select({ n: sql<number>`count(*)` }).from(idea).where(and(eq(idea.orgId, orgId), eq(idea.status, "new")));
  return { drafts: Number(drafts?.n ?? 0), ideas: Number(ideas?.n ?? 0) };
}
