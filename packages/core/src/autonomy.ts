// Phase 5: autonomy and learning. Ideas from sources, autopilot, the engagement listener,
// audience insights and analytics. Every function filters by orgId (tenant isolation lives here).
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import {
  brief,
  connection,
  contextItem,
  draft,
  engagement,
  idea,
  insight,
  passion,
  postMetrics,
  source,
  type ContentMode,
  type Db,
  type Platform,
} from "@nextrium/db";
import { generateStructured, insightSystemPrompt, insightUserPrompt, InsightSchema, type Provider } from "@nextrium/llm";
import { blueskyEngagement, mastodonEngagement, type FetchLike, type PostEngagement } from "@nextrium/platforms";
import { addContextItems, backfillPublishedAt, compose, getOrgPlan, getPersona, markSourceChecked } from "./content.js";
import { ageOf, baseScore, effectiveScore, IDEA_SHOW_MIN, isStale, sameStory, type IdeaOrigin } from "./idea-score.js";
import { PLAN_FEATURES } from "./plans.js";
import { chunkRows } from "./chunk.js";
import { newId } from "./ids.js";
import { ingestFeed, ingestGithubActivity, ingestWatchedPage, resolveBlogSource } from "./ingest.js";
import { sourceIsLive } from "./passions.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// --- Sources -> ideas ------------------------------------------------------------------

/** The base score (no AI; see idea-score.ts) and the idea's reason line. Freshness is added when it's read. */
export function scoreIdea(kind: string, title: string, label?: string, ctx: { body?: string; keywords?: string[]; passionName?: string | null } = {}): { score: number; reason: string } {
  const what = label ?? (kind === "github_release" ? "New release" : kind === "github_activity" ? "Your work" : kind === "rss_item" ? "New post" : "New material");
  return { score: baseScore({ kind, title, ...ctx }), reason: `${what}: ${title || "untitled"}`.slice(0, 200) };
}

/**
 * Turns new material into ideas. The same story from several sources (or twice from one) becomes one
 * idea: the existing one gets +10 instead, since more sources covering it means it matters more.
 */
export async function createIdeas(
  db: Db,
  orgId: string,
  kind: string,
  items: { id: string; title: string; body?: string }[],
  label?: string,
  ctx: { keywords?: string[]; passionName?: string | null } = {},
) {
  if (!items.length) return 0;
  const recent = await db
    .select({ id: idea.id, score: idea.score, title: contextItem.title })
    .from(idea)
    .innerJoin(contextItem, eq(contextItem.id, idea.contextItemId))
    .where(and(eq(idea.orgId, orgId), gte(idea.createdAt, new Date(Date.now() - 7 * DAY))))
    .orderBy(desc(idea.createdAt))
    .limit(200);
  const rows: { id: string; orgId: string; contextItemId: string; reason: string; score: number; scoreVersion: number }[] = [];
  const bumped = new Set<string>();
  for (const i of items) {
    const { score, reason } = scoreIdea(kind, i.title, label, { ...(i.body !== undefined ? { body: i.body } : {}), ...ctx });
    const same = recent.find((r) => sameStory(r.title, i.title));
    if (same) {
      if (!bumped.has(same.id)) {
        bumped.add(same.id);
        await db.update(idea).set({ score: Math.min(100, same.score + 10) }).where(and(eq(idea.orgId, orgId), eq(idea.id, same.id)));
      }
      continue;
    }
    if (rows.some((r) => sameStory(r.reason, i.title))) continue;
    rows.push({ id: newId("idea"), orgId, contextItemId: i.id, reason, score, scoreVersion: 2 });
  }
  let added = 0;
  for (const part of chunkRows(rows, 7)) {
    added += (await db.insert(idea).values(part).onConflictDoNothing({ target: [idea.orgId, idea.contextItemId] }).returning({ id: idea.id })).length;
  }
  return added;
}

/**
 * Cron: re-scores ideas made under the first rules (a few hundred per run), so old ones fade and
 * noise drops out too. A day of GitHub work gets its date back from its id ("gh-day:repo:YYYY-MM-DD").
 */
export async function rescoreOldIdeas(db: Db, limit = 200) {
  const rows = await db
    .select({ id: idea.id, orgId: idea.orgId, ctxId: contextItem.id, kind: contextItem.kind, title: contextItem.title, body: sql<string>`substr(${contextItem.body}, 1, 1000)`, externalId: contextItem.externalId, publishedAt: contextItem.publishedAt, passionName: passion.name })
    .from(idea)
    .innerJoin(contextItem, eq(contextItem.id, idea.contextItemId))
    .leftJoin(source, eq(source.id, contextItem.sourceId))
    .leftJoin(passion, eq(passion.id, source.passionId))
    .where(eq(idea.scoreVersion, 1))
    .limit(limit);
  const keywords = new Map<string, string[]>();
  for (const r of rows) {
    if (!keywords.has(r.orgId)) {
      const who = await getPersona(db, r.orgId);
      keywords.set(r.orgId, [...(who?.interests ?? []), ...(who?.expertise ?? [])]);
    }
    const day = !r.publishedAt ? r.externalId?.match(/^gh-day:.+:(\d{4}-\d{2}-\d{2})$/)?.[1] : undefined;
    if (day) await db.update(contextItem).set({ publishedAt: new Date(`${day}T23:59:59Z`) }).where(eq(contextItem.id, r.ctxId));
    const score = baseScore({ kind: r.kind, title: r.title, body: r.body, keywords: keywords.get(r.orgId) ?? [], passionName: r.passionName });
    await db.update(idea).set({ score, scoreVersion: 2 }).where(eq(idea.id, r.id));
  }
  return rows.length;
}

/** Items older than this aren't brought in at all, and a source's first check brings at most 3 per kind. */
const MAX_ITEM_AGE = 14 * DAY;
const FIRST_CHECK_ITEMS = 3;
function freshOnly<T extends { publishedAt?: Date | null }>(items: T[], firstCheck: boolean, now: Date): T[] {
  const recent = items
    .filter((i) => !i.publishedAt || now.getTime() - i.publishedAt.getTime() <= MAX_ITEM_AGE)
    .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
  return firstCheck ? recent.slice(0, FIRST_CHECK_ITEMS) : recent;
}

/** What an item from this source is, for the idea's reason line. */
function sourceLabel(key: string, kind: string): string | undefined {
  if (kind !== "rss_item") return undefined;
  if (/youtube\.com|youtu\.be/i.test(key)) return "New video";
  if (/podcast|anchor\.fm|buzzsprout|libsyn|podbean|transistor|simplecast|megaphone|spreaker|acast/i.test(key)) return "New episode";
  return "New article";
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
    } else if (src.kind === "page") {
      const watched = await ingestWatchedPage(src.key, src.seen, { fetch: opts.fetch });
      batches.push({ kind: "rss_item", items: watched.items });
      await db.update(source).set({ seen: watched.seen }).where(eq(source.id, src.id));
    } else {
      let items: Awaited<ReturnType<typeof ingestFeed>>;
      try {
        items = await ingestFeed(src.key, opts.fetch);
      } catch (error) {
        if (!(error instanceof Error && /Unsupported content type|HTTP 404/.test(error.message))) throw error;
        const resolved = await resolveBlogSource(src.key, opts.fetch);
        const fixed = { ...src, kind: resolved.kind, key: resolved.key, seen: [] as string[] };
        try {
          await db.update(source).set({ kind: fixed.kind, key: fixed.key, seen: [] }).where(eq(source.id, src.id));
        } catch {
          throw new Error(`This address is already connected as ${resolved.key}. Remove one of them.`);
        }
        return syncSource(db, fixed, opts);
      }
      batches.push({ kind: "rss_item", items });
    }
    let added = 0;
    let ideas = 0;
    // A passion's ideas carry its name ("Cardano: <title>"), so they're easy to tell apart in Ideas.
    const [pas] = src.passionId ? await db.select({ name: passion.name }).from(passion).where(and(eq(passion.orgId, src.orgId), eq(passion.id, src.passionId))) : [];
    const who = await getPersona(db, src.orgId);
    const keywords = [...(who?.interests ?? []), ...(who?.expertise ?? [])];
    const now = opts.now ?? new Date();
    for (const b of batches) {
      if (src.lastCheckedAt) await backfillPublishedAt(db, src.orgId, b.items);
      const rows = await addContextItems(db, src.orgId, b.kind, freshOnly(b.items, !src.lastCheckedAt, now), src.id);
      added += rows.length;
      ideas += await createIdeas(db, src.orgId, b.kind, rows, pas?.name ?? sourceLabel(src.key, b.kind), { keywords, passionName: pas?.name ?? null });
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
    .where(
      and(
        or(isNull(source.lastCheckedAt), lt(source.lastCheckedAt, new Date(now.getTime() - 6 * HOUR))),
        // "Find ideas" switched off in Automation: sources are checked only when the person asks.
        sql`NOT EXISTS (SELECT 1 FROM autopilot a WHERE a.org_id = ${source.orgId} AND a.find_ideas = 0)`,
        // A passion that's off or outside its dates isn't checked.
        sourceIsLive(source.passionId, now.toISOString().slice(0, 10)),
      ),
    )
    .orderBy(asc(source.lastCheckedAt))
    .limit(limit);
  let ideas = 0;
  for (const src of due) ideas += (await syncSource(db, src, opts)).ideas;
  return { checked: due.length, ideas };
}

/** Ideas with their score as of now (base + freshness), whether they're stale, and where they came from. */
async function scoredIdeas(db: Db, orgId: string, status: "new" | "drafted" | "dismissed", now: Date) {
  const rows = await db
    .select({
      id: idea.id,
      reason: idea.reason,
      base: idea.score,
      status: idea.status,
      createdAt: idea.createdAt,
      contextItemId: idea.contextItemId,
      title: contextItem.title,
      kind: contextItem.kind,
      body: sql<string>`substr(${contextItem.body}, 1, 400)`,
      url: contextItem.url,
      publishedAt: contextItem.publishedAt,
      passionId: source.passionId,
      relation: passion.relation,
    })
    .from(idea)
    .innerJoin(contextItem, eq(contextItem.id, idea.contextItemId))
    .leftJoin(source, eq(source.id, contextItem.sourceId))
    .leftJoin(passion, eq(passion.id, source.passionId))
    .where(and(eq(idea.orgId, orgId), eq(idea.status, status)))
    .orderBy(desc(idea.score), desc(idea.createdAt))
    .limit(200);
  return rows
    .map(({ base, passionId, relation, ...r }) => {
      // A passion that's "ours" is the person's own team: their own material, not outside news.
      const origin: IdeaOrigin = passionId && relation !== "ours" ? "outside" : "own";
      const age = ageOf(r.publishedAt, r.createdAt, now);
      return { ...r, score: effectiveScore(base, age), stale: isStale(age, origin), origin };
    })
    .sort((a, b) => b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime());
}

/** New ideas worth looking at (score 40+ and not stale), best first; `all` includes the rest. */
export async function listIdeas(db: Db, orgId: string, status: "new" | "drafted" | "dismissed" = "new", opts: { all?: boolean; now?: Date } = {}) {
  const rows = await scoredIdeas(db, orgId, status, opts.now ?? new Date());
  const shown = status !== "new" || opts.all ? rows : rows.filter((r) => r.score >= IDEA_SHOW_MIN && !r.stale);
  return shown.slice(0, 50).map(({ stale: _stale, origin: _origin, ...r }) => r);
}

/** Counts per status; "new" counts only the ideas worth looking at, and `hidden` the rest. */
export async function ideaCounts(db: Db, orgId: string, now = new Date()) {
  const rows = await db.select({ status: idea.status, n: sql<number>`count(*)` }).from(idea).where(eq(idea.orgId, orgId)).groupBy(idea.status);
  const out = { new: 0, drafted: 0, dismissed: 0, hidden: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  if (out.new) {
    const scored = await scoredIdeas(db, orgId, "new", now);
    const worth = scored.filter((r) => r.score >= IDEA_SHOW_MIN && !r.stale).length;
    out.hidden = out.new - worth;
    out.new = worth;
  }
  return out;
}

/** One idea with its full material, and the brief written from it (if any) so its posts can be listed. */
export async function getIdea(db: Db, orgId: string, id: string) {
  const [row] = await db
    .select({
      id: idea.id,
      reason: idea.reason,
      score: idea.score,
      status: idea.status,
      createdAt: idea.createdAt,
      contextItemId: idea.contextItemId,
      title: contextItem.title,
      kind: contextItem.kind,
      body: sql<string>`substr(${contextItem.body}, 1, 6000)`,
      url: contextItem.url,
      publishedAt: contextItem.publishedAt,
    })
    .from(idea)
    .innerJoin(contextItem, eq(contextItem.id, idea.contextItemId))
    .where(and(eq(idea.orgId, orgId), eq(idea.id, id)));
  if (!row) return null;
  const [b] = await db.select({ id: brief.id }).from(brief).where(and(eq(brief.orgId, orgId), eq(brief.contextItemId, row.contextItemId))).orderBy(desc(brief.createdAt)).limit(1);
  return { ...row, score: effectiveScore(row.score, ageOf(row.publishedAt, row.createdAt)), briefId: b?.id ?? null };
}

/** Brings a dismissed idea back. */
export async function restoreIdea(db: Db, orgId: string, id: string) {
  const rows = await db.update(idea).set({ status: "new" }).where(and(eq(idea.orgId, orgId), eq(idea.id, id), eq(idea.status, "dismissed"))).returning({ id: idea.id });
  return rows.length > 0;
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
export async function composeIdea(db: Db, providers: Provider[], input: { orgId: string; ideaId: string; mode: ContentMode; platforms: Platform[]; thread?: boolean | undefined }) {
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
    return await compose(db, providers, { orgId: input.orgId, contextItemId: claimed.contextItemId, mode: input.mode, platforms: input.platforms, ...(input.thread ? { thread: true } : {}) });
  } catch (error) {
    await db.update(idea).set({ status: "new", draftedAt: null }).where(eq(idea.id, input.ideaId));
    throw error;
  }
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
  const [needs] = await db
    .select({ n: sql<number>`count(*)` })
    .from(draft)
    .where(and(eq(draft.orgId, orgId), gt(draft.urgentUntil, new Date()), inArray(draft.status, ["draft", "approved"])));
  // Only the ideas worth looking at (the same ones Ideas shows by default).
  return { drafts: Number(drafts?.n ?? 0), ideas: (await ideaCounts(db, orgId)).new, needsYou: Number(needs?.n ?? 0) };
}
