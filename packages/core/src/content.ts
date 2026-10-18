// Persona, context items, drafts and the compose pipeline. Every function takes orgId and
// filters by it: tenant isolation lives here, never in the caller.
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import {
  brief,
  connection,
  contextItem,
  draft,
  org,
  persona,
  source,
  type BriefResearch,
  type ContentMode,
  type Db,
  type Stance,
  type DraftStatus,
  type Platform,
} from "@nextrium/db";
import {
  checkVariants,
  cleanPost,
  ComposeSchema,
  composeSystemPrompt,
  composeUserPrompt,
  generateStructured,
  repairUserPrompt,
  RepairSchema,
  runResearch,
  type Provider,
  type ResearchProvider,
} from "@nextrium/llm";
import { checkFacts, hasErrors, lintPost, lintThread, THREAD_PLATFORMS, X_LONG_MAX, X_LONG_SUBSCRIPTIONS, type LintIssue } from "@nextrium/policy";
import { getBalance, InsufficientCreditsError, postCreditTxn } from "./credits.js";
import { chunkRows } from "./chunk.js";
import { newId } from "./ids.js";
import { recordAudit } from "./orgs.js";
import type { IngestedItem } from "./ingest.js";
import { openingOf, recentPosts, repeats } from "./repetition.js";
import { passionForContext } from "./passions.js";
import { addUsage, CREDITS_PER_EXTRA_POST, CREDITS_PER_EXTRA_RESEARCH, getUsage, limitsFor, seatsFor, type Limits, type Plan } from "./plans.js";

// --- Persona ----------------------------------------------------------------

export type PersonaData = Omit<typeof persona.$inferInsert, "orgId" | "updatedAt">;

export async function getPersona(db: Db, orgId: string) {
  const [row] = await db.select().from(persona).where(eq(persona.orgId, orgId));
  return row ?? null;
}

export async function savePersona(db: Db, orgId: string, data: PersonaData) {
  await db
    .insert(persona)
    .values({ ...data, orgId })
    .onConflictDoUpdate({ target: persona.orgId, set: { ...data, updatedAt: new Date() } });
  return getPersona(db, orgId);
}

// --- Context items ----------------------------------------------------------

export async function addContextItems(
  db: Db,
  orgId: string,
  kind: (typeof contextItem.$inferInsert)["kind"],
  items: IngestedItem[],
  sourceId: string | null = null,
) {
  if (!items.length) return [];
  const rows = items.map((i) => ({ id: newId("ctx"), orgId, sourceId, kind, title: i.title, body: i.body, url: i.url, externalId: i.externalId, publishedAt: i.publishedAt ?? null }));
  // Items already seen from a source (same externalId) are skipped, not duplicated.
  const added: { id: string; title: string; body: string; publishedAt: Date | null }[] = [];
  for (const part of chunkRows(rows, 9)) {
    added.push(...(await db.insert(contextItem).values(part).onConflictDoNothing({ target: [contextItem.orgId, contextItem.externalId] }).returning({ id: contextItem.id, title: contextItem.title, body: contextItem.body, publishedAt: contextItem.publishedAt })));
  }
  return added;
}

/** Items stored before publish dates were kept get theirs from the next check, so their ideas can fade with age. */
export async function backfillPublishedAt(db: Db, orgId: string, items: IngestedItem[]) {
  for (const i of items.filter((x) => x.publishedAt && x.externalId).slice(0, 25)) {
    await db.update(contextItem).set({ publishedAt: i.publishedAt! }).where(and(eq(contextItem.orgId, orgId), eq(contextItem.externalId, i.externalId!), isNull(contextItem.publishedAt)));
  }
}

export async function listContextItems(db: Db, orgId: string, limit = 50) {
  return db
    .select({ id: contextItem.id, kind: contextItem.kind, title: contextItem.title, body: contextItem.body, url: contextItem.url, createdAt: contextItem.createdAt })
    .from(contextItem)
    .where(eq(contextItem.orgId, orgId))
    .orderBy(desc(contextItem.createdAt))
    .limit(limit);
}

// --- Sources ----------------------------------------------------------------

export class SourceLimitError extends Error {
  constructor(limit: number) {
    super(`Your plan allows ${limit} connected source${limit === 1 ? "" : "s"}. Remove one or upgrade.`);
    this.name = "SourceLimitError";
  }
}

export async function addSource(db: Db, orgId: string, _plan: Plan, kind: "github_repo" | "rss" | "page", key: string) {
  // Passions have their own sources and allowance; only the person's own sources count here.
  const existing = await db.select({ id: source.id }).from(source).where(and(eq(source.orgId, orgId), isNull(source.passionId)));
  const { sources: limit } = (await getOrgLimits(db, orgId)).limits;
  if (existing.length >= limit) throw new SourceLimitError(limit);
  const [row] = await db
    .insert(source)
    .values({ id: newId("src"), orgId, kind, key })
    .onConflictDoNothing({ target: [source.orgId, source.kind, source.key] })
    .returning();
  return row ?? null;
}

/** The person's own sources (a passion's sources are listed with the passion). */
export async function listSources(db: Db, orgId: string) {
  return db.select().from(source).where(and(eq(source.orgId, orgId), isNull(source.passionId))).orderBy(desc(source.createdAt));
}

export async function getSource(db: Db, orgId: string, id: string) {
  const [row] = await db.select().from(source).where(and(eq(source.orgId, orgId), eq(source.id, id)));
  return row ?? null;
}

export async function removeSource(db: Db, orgId: string, id: string) {
  const removed = await db.delete(source).where(and(eq(source.orgId, orgId), eq(source.id, id))).returning({ id: source.id });
  return removed.length > 0;
}

export async function markSourceChecked(db: Db, orgId: string, id: string, error: string | null) {
  await db.update(source).set({ lastCheckedAt: new Date(), lastError: error }).where(and(eq(source.orgId, orgId), eq(source.id, id)));
}

// --- Compose ----------------------------------------------------------------

export class ComposeError extends Error {
  constructor(
    readonly code: "persona_required" | "context_not_found" | "no_platforms" | "quota_exceeded" | "ai_unavailable" | "research_unavailable" | "research_empty",
    message: string,
  ) {
    super(message);
    this.name = "ComposeError";
  }
}

/** The plan that applies: the paid plan, or the staff tier when a platform admin granted full access. */
export async function getOrgPlan(db: Db, orgId: string): Promise<Plan> {
  const [row] = await db.select({ plan: org.plan, fullAccess: org.fullAccess }).from(org).where(eq(org.id, orgId));
  if (row?.fullAccess) return "staff";
  return (row?.plan ?? "free") as Plan;
}

/** The plan, its allowance (scaled by paid seats for a per-member Team) and how many members it allows. */
export async function getOrgLimits(db: Db, orgId: string): Promise<{ plan: Plan; limits: Limits; seats: number }> {
  const [row] = await db.select({ plan: org.plan, fullAccess: org.fullAccess, seats: org.seats }).from(org).where(eq(org.id, orgId));
  const plan: Plan = row?.fullAccess ? "staff" : ((row?.plan ?? "free") as Plan);
  return { plan, limits: limitsFor(plan, row?.seats), seats: seatsFor(plan, row?.seats) };
}

/** Platform admins only (checked by the caller): grant or remove full access for a workspace. Audited. */
export async function setFullAccess(db: Db, orgId: string, input: { full: boolean; note: string; actorUserId: string }) {
  const [row] = await db
    .update(org)
    .set(input.full ? { fullAccess: true, fullAccessNote: input.note, fullAccessBy: input.actorUserId, fullAccessAt: new Date() } : { fullAccess: false, fullAccessNote: null, fullAccessBy: null, fullAccessAt: null })
    .where(eq(org.id, orgId))
    .returning({ id: org.id });
  if (row) await recordAudit(db, { orgId, actorUserId: input.actorUserId, action: input.full ? "access.granted" : "access.removed", target: orgId, meta: { note: input.note } });
  return Boolean(row);
}

export async function listFullAccess(db: Db) {
  return db.select({ id: org.id, name: org.name, note: org.fullAccessNote, at: org.fullAccessAt }).from(org).where(eq(org.fullAccess, true)).orderBy(desc(org.fullAccessAt)).limit(200);
}

/** Whether any connected X account in the workspace can post long (Premium) posts. */
export async function xLongAllowed(db: Db, orgId: string): Promise<boolean> {
  const rows = await db.select({ meta: connection.meta }).from(connection).where(and(eq(connection.orgId, orgId), eq(connection.platform, "x"), eq(connection.status, "active")));
  return rows.some((r) => X_LONG_SUBSCRIPTIONS.includes(r.meta.subscription ?? ""));
}

/** Lint a post or a thread with the workspace's limits (X Premium raises the X limit). */
export function lintDraft(platform: Platform, text: string, parts: string[] | null | undefined, xLong: boolean): LintIssue[] {
  // X Premium: long posts, also as the first post of a thread (e.g. a post with its link as the reply).
  const opts = platform === "x" && xLong ? { maxLength: X_LONG_MAX } : {};
  return parts ? lintThread(platform, parts, opts) : lintPost(platform, text, opts);
}

export const joinParts = (parts: string[]) => parts.map((p) => p.trim()).join("\n\n");

export type ComposeInput = {
  orgId: string;
  contextItemId: string;
  /** "auto": the writer picks the style from the request. */
  mode: ContentMode | "auto";
  platforms: Platform[];
  thread?: boolean | undefined;
  /** The person's own instructions for these posts. */
  instructions?: string | undefined;
  stance?: Stance | undefined;
  /** Look up facts on the web first (uses the research allowance, then credits). */
  research?: boolean | undefined;
};

// --- The source link -------------------------------------------------------------------------

/** Where the source link goes: at the end of the post here; on X, as the first reply; nowhere else (Instagram captions don't link, video scripts are spoken). */
export const LINK_AT_END: Platform[] = ["linkedin", "facebook", "threads", "bluesky", "mastodon"];
const POINTER_RE = /\b(reply|replies|below|thread)\b|👇|⬇/i;
const POINTERS = ["Link in the reply 👇", "The link is in the reply.", "More in the reply below 👇"];

/** The link a post should carry: the item's own page; for a day of GitHub work, the repository's main page. */
export function sourceLink(ctx: { kind: string; url: string | null }): string | null {
  if (!ctx.url || !/^https:\/\/[^\s]+$/i.test(ctx.url) || ctx.kind === "request") return null;
  if (ctx.kind === "github_activity") return ctx.url.replace(/\/commits\/?$/, "");
  return ctx.url;
}

/** The post with its link placed: at the end where links work; on X, without the link but with a line pointing to the reply. */
export function placeLink(platform: Platform, text: string, link: string | null): string {
  if (!link) return text;
  if (platform === "x") {
    const without = text.split(link).join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return POINTER_RE.test(without) ? without : `${without}\n\n${POINTERS[without.length % POINTERS.length]}`;
  }
  if (!LINK_AT_END.includes(platform) || text.includes(link)) return text;
  return `${text.trimEnd()}\n\n${link}`;
}

/**
 * Words that sound as if the author is part of a team they've said they only follow ("we built",
 * "the tools we build", "our team"). Flagged for the person to check; automation won't approve it.
 */
const TEAM_CLAIM_RE = /\bwe(?:'ve|'re|'ll)?\s+(?:(?:can|could|will|just|also|now|have|are|recently|finally)\s+)?(?:built|build|building|created|create|launched|launch|shipped|ship|designed|developed|develop|made|released|release|maintain|wrote)\b|\bour\s+(?:team|repo|repository|codebase|product|tool|tools|project|release|roadmap)\b/i;
export function soundsLikeTeam(text: string): boolean {
  return TEAM_CLAIM_RE.test(text);
}

/**
 * A passion's disclosure, exactly as the person wrote it (house-style cleanup never touches it, so "#ad"
 * survives). Added at the end unless the post already contains it.
 */
/** The text without the disclosure the writer may have added itself (so the code can put it last, after the link). */
export function withoutDisclosure(text: string, disclosure: string): string {
  const d = disclosure.trim();
  if (!d) return text;
  const at = text.toLowerCase().lastIndexOf(d.toLowerCase());
  return at < 0 ? text : `${text.slice(0, at)}${text.slice(at + d.length)}`.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function withDisclosure(text: string, disclosure: string): string {
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
  return norm(text).includes(norm(disclosure)) ? text : `${text.trimEnd()}\n\n${disclosure.trim()}`;
}

export async function compose(db: Db, providers: Provider[], input: ComposeInput, opts: { research?: ResearchProvider[] } = {}) {
  const platforms = [...new Set(input.platforms)];
  const threadFor = input.thread ? platforms.filter((p) => THREAD_PLATFORMS.includes(p)) : [];
  if (!platforms.length) throw new ComposeError("no_platforms", "Choose at least one platform.");
  const who = await getPersona(db, input.orgId);
  if (!who) throw new ComposeError("persona_required", "Set up your voice first, so posts sound like you.");
  const [ctx] = await db
    .select()
    .from(contextItem)
    .where(and(eq(contextItem.orgId, input.orgId), eq(contextItem.id, input.contextItemId)));
  if (!ctx) throw new ComposeError("context_not_found", "That item wasn't found in your workspace.");
  // "Ask the AI": the saved item is the person's own request, so it's followed as an instruction.
  const isRequest = ctx.kind === "request";
  const instructions = [isRequest ? ctx.body : "", input.instructions?.trim() ?? ""].filter(Boolean).join("\n\n").slice(0, 6000) || null;
  const material = isRequest ? { title: "", body: "" } : { title: ctx.title, body: ctx.body };
  // Material from a passion's sources is someone else's work: written as the person's view of it.
  const passion = isRequest ? null : await passionForContext(db, input.orgId, ctx.id);
  // "It's ours": the person's own team, written as their own work. Otherwise their view of someone else's.
  const stance: Stance = input.stance ?? (passion && passion.relation !== "ours" ? "other" : "own");
  // The source's link (the person can switch it off per passion). Added by the code, never by the writer.
  const link = (passion ? passion.linkSource : true) ? sourceLink(ctx) : null;

  // Quota pre-check: posts left this month plus credits must cover the request.
  const { limits } = await getOrgLimits(db, input.orgId);
  const used = (await getUsage(db, input.orgId)).postsGenerated;
  const left = Math.max(0, limits.posts - used);
  if (left < platforms.length && (await getBalance(db, input.orgId)) < (platforms.length - left) * CREDITS_PER_EXTRA_POST) {
    throw new ComposeError("quota_exceeded", `You've used this month's ${limits.posts} posts and don't have enough credits for ${platforms.length} more.`);
  }

  // Research first, when asked: facts from the web, each with a link the search returned.
  let research: BriefResearch | null = null;
  let researchCost = 0;
  if (input.research) {
    if (!opts.research?.length) throw new ComposeError("research_unavailable", "Web research isn't set up in this environment.");
    const researchLeft = limits.research - (await getUsage(db, input.orgId)).researchRuns;
    const postCredits = Math.max(0, platforms.length - left) * CREDITS_PER_EXTRA_POST;
    if (researchLeft <= 0 && (await getBalance(db, input.orgId)) < CREDITS_PER_EXTRA_RESEARCH + postCredits) {
      throw new ComposeError("quota_exceeded", `You've used this month's ${limits.research} web researches. Each extra one is ${CREDITS_PER_EXTRA_RESEARCH} credits.`);
    }
    try {
      const body = `${material.title}\n${material.body}`.trim();
      const found = await runResearch(opts.research, { request: instructions ?? body, material: instructions && body ? body : undefined });
      researchCost = found.costMicroUsd;
      research = { model: found.model, subject: found.subject, summary: found.summary, facts: found.facts, criticism: found.criticism, support: found.support, hints: found.hints, sources: found.sources };
    } catch (error) {
      console.error("research failed", error);
      throw new ComposeError("research_unavailable", "Web research didn't work just now. Try again in a minute, or write without research.");
    }
    if (!research.facts.length && !research.criticism.length && !research.support.length) {
      // Nothing reliable found: don't write a post that pretends otherwise. The search still counts (it cost money).
      await chargeResearch(db, input.orgId, limits, `research:${newId("txn")}`);
      throw new ComposeError("research_empty", "The web search found nothing reliable about this. Add the facts you know (with links if you have them), or write without research.");
    }
  }

  const system = composeSystemPrompt(who);
  // Recent posts on these platforms: their openings go to the writer to avoid, and new posts are checked against them.
  const recent = await recentPosts(db, input.orgId, platforms);
  const recentOpenings = [...new Set(recent.map((r) => openingOf(r.text)).filter((o) => o.length >= 12))].slice(0, 8);
  const xLong = platforms.includes("x") && (await xLongAllowed(db, input.orgId));
  let result;
  try {
    result = await generateStructured(
      providers,
      { system, user: composeUserPrompt({ mode: input.mode, platforms, contextTitle: material.title, contextBody: material.body, thread: threadFor, xLong, instructions, stance, research, recentOpenings, passion, link: link ? { length: link.length, atEnd: LINK_AT_END, xReply: true } : null }), maxTokens: 8000 },
      ComposeSchema,
      (out) => checkVariants(out, platforms),
    );
  } catch (error) {
    console.error("compose failed", error);
    throw new ComposeError("ai_unavailable", "The writing engine is busy right now. Please try again in a minute.");
  }

  // Why a fallback model wrote this (kept in the logs, so a failing provider is noticed).
  if (result.attempts.length) console.warn("compose fell back", { model: result.model, attempts: result.attempts });
  let cost = result.costMicroUsd + researchCost;
  const variants: { platform: Platform; text: string; parts: string[] | null; issues: LintIssue[] }[] = [];
  // What a post may state: the material, the person's own request, and what research found (with its links).
  const source = [
    ctx.title,
    ctx.body,
    instructions ?? "",
    ...(passion ? [passion.name, passion.about, passion.disclosure] : []),
    ...(link ? [link, ctx.url ?? ""] : []),
    ...(research ? [research.summary, ...research.facts.map((f) => `${f.claim} ${f.source}`), ...research.criticism.map((f) => `${f.point} ${f.source}`), ...research.support.map((f) => `${f.point} ${f.source}`)] : []),
  ].join("\n");
  // "I follow it": words that claim the team's work are flagged (the writer is told not to, but check).
  const teamIssue = (text: string): LintIssue[] =>
    passion?.relation === "follow" && soundsLikeTeam(text)
      ? [{ code: "sounds_like_team", severity: "warn", message: `This sounds as if you're part of ${passion.name}'s team. Reword it as your view, or change how you're connected to it in Passions.` }]
      : [];
  for (const v of result.data.variants.filter((x) => platforms.includes(x.platform))) {
    // Threads: each part cleaned and checked; one repair attempt for up to 3 parts that are too long.
    const wanted = threadFor.includes(v.platform) ? (v.parts ?? []).map(cleanPost).filter(Boolean) : [];
    if (wanted.length && passion?.disclosure) wanted[wanted.length - 1] = withDisclosure(wanted[wanted.length - 1]!, passion.disclosure);
    if (wanted.length > 1) {
      const parts = wanted.slice(0, 20);
      let repairs = 0;
      for (let i = 0; i < parts.length && repairs < 3; i++) {
        const partIssues = lintPost(v.platform, parts[i]!);
        if (!hasErrors(partIssues)) continue;
        repairs++;
        try {
          const fixed = await generateStructured(providers, { system, user: repairUserPrompt(v.platform, parts[i]!, partIssues.filter((x) => x.severity === "error").map((x) => x.message).join(" ")), maxTokens: 1000 }, RepairSchema);
          cost += fixed.costMicroUsd;
          const t = i === parts.length - 1 && passion?.disclosure ? withDisclosure(cleanPost(fixed.data.text), passion.disclosure) : cleanPost(fixed.data.text);
          if (!hasErrors(lintPost(v.platform, t))) parts[i] = t;
        } catch {
          // The issue stays visible on that part.
        }
      }
      if (link && (v.platform === "x" || LINK_AT_END.includes(v.platform))) parts.push(link);
      const text = joinParts(parts);
      variants.push({ platform: v.platform, text, parts, issues: [...lintDraft(v.platform, text, parts, xLong), ...checkFacts(text, source), ...teamIssue(text)] });
      continue;
    }
    // Link placed first (X: a line pointing to the reply), then the disclosure at the very end.
    const finish = (raw: string) => {
      const cleaned = cleanPost(raw);
      const placed = placeLink(v.platform, link && passion?.disclosure ? withoutDisclosure(cleaned, passion.disclosure) : cleaned, link);
      return passion?.disclosure ? withDisclosure(placed, passion.disclosure) : placed;
    };
    let text = finish(v.text);
    let issues = lintDraft(v.platform, text, null, xLong);
    // One repair attempt for hard errors (too long, placeholders); otherwise keep and show the issue.
    if (hasErrors(issues)) {
      try {
        const fixed = await generateStructured(
          providers,
          { system, user: repairUserPrompt(v.platform, text, issues.filter((i) => i.severity === "error").map((i) => i.message).join(" ")), maxTokens: 2000 },
          RepairSchema,
        );
        cost += fixed.costMicroUsd;
        const fixedText = finish(fixed.data.text);
        const fixedIssues = lintDraft(v.platform, fixedText, null, xLong);
        if (!hasErrors(fixedIssues)) {
          text = fixedText;
          issues = fixedIssues;
        }
      } catch {
        // Keep the original; the error stays visible to the user.
      }
    }
    // X: the link goes out as the first reply, so the post becomes a two-part thread.
    if (link && v.platform === "x") {
      const parts = [text, link];
      variants.push({ platform: v.platform, text: joinParts(parts), parts, issues: [...lintDraft(v.platform, joinParts(parts), parts, xLong), ...checkFacts(text, source), ...teamIssue(text)] });
      continue;
    }
    variants.push({ platform: v.platform, text, parts: null, issues: [...issues, ...checkFacts(text, source), ...teamIssue(text)] });
  }

  // Hints research couldn't confirm: the person checks they're written as their own knowledge.
  const unconfirmed = research?.hints.filter((h) => h.status === "unconfirmed").length ?? 0;
  const researchIssue: LintIssue[] = unconfirmed
    ? [{ code: "unconfirmed_hint", severity: "warn", message: `${unconfirmed} of your hints weren't found in any source. Check the post presents them as what you know, not as reported fact.` }]
    : [];
  const briefId = newId("brf");
  const rows = variants.map((v) => {
    const same = repeats(v.text, recent.filter((r) => r.platform === v.platform).map((r) => r.text));
    const repeatIssue: LintIssue[] = same.repeated ? [{ code: "too_similar", severity: "warn", message: `${same.reason} Rewrite it before posting.` }] : [];
    return { id: newId("drf"), orgId: input.orgId, briefId, platform: v.platform, text: v.text, parts: v.parts, issues: [...v.issues, ...researchIssue, ...repeatIssue] };
  });
  await db.batch([
    db.insert(brief).values({
      id: briefId,
      orgId: input.orgId,
      contextItemId: ctx.id,
      mode: input.mode === "auto" ? (result.data.mode ?? "expert_take") : input.mode,
      angle: result.data.angle,
      keyPoints: result.data.key_points,
      model: research ? `${result.model} + ${research.model}` : result.model,
      costMicroUsd: cost,
      instructions,
      stance,
      research,
    }),
    db.insert(draft).values(rows),
  ]);

  // Charge usage after success. A concurrent request can push slightly past the limit;
  // the extra is billed in credits when available (cost per post is ~$0.00003).
  const { overage } = await addUsage(db, input.orgId, "postsGenerated", rows.length, limits.posts);
  if (overage > 0) {
    try {
      await postCreditTxn(db, { orgId: input.orgId, kind: "spend", amount: -overage * CREDITS_PER_EXTRA_POST, idempotencyKey: `compose:${briefId}`, description: `${overage} extra post${overage === 1 ? "" : "s"}` });
    } catch (error) {
      if (!(error instanceof InsufficientCreditsError)) throw error;
      console.warn("overage without credits after concurrent compose", { orgId: input.orgId, overage });
    }
  }

  if (research) await chargeResearch(db, input.orgId, limits, `research:${briefId}`);

  return { briefId, model: result.model, angle: result.data.angle, research, drafts: await listDrafts(db, input.orgId, { briefId }) };
}

/** Counts a web research; beyond the plan's allowance it's paid in credits (when there are enough). */
async function chargeResearch(db: Db, orgId: string, limits: Limits, idempotencyKey: string) {
  const { overage } = await addUsage(db, orgId, "researchRuns", 1, limits.research);
  if (!overage) return;
  try {
    await postCreditTxn(db, { orgId, kind: "spend", amount: -CREDITS_PER_EXTRA_RESEARCH, idempotencyKey, description: "Web research" });
  } catch (error) {
    if (!(error instanceof InsufficientCreditsError)) throw error;
    console.warn("research overage without credits after concurrent compose", { orgId });
  }
}

// --- Drafts -----------------------------------------------------------------

export async function listDrafts(db: Db, orgId: string, filter: { status?: DraftStatus; briefId?: string } = {}) {
  const conditions = [eq(draft.orgId, orgId)];
  if (filter.status) conditions.push(eq(draft.status, filter.status));
  if (filter.briefId) conditions.push(eq(draft.briefId, filter.briefId));
  return db.select().from(draft).where(and(...conditions)).orderBy(desc(draft.createdAt)).limit(200);
}

export type DraftSource = {
  mode: string;
  kind: string | null;
  title: string | null;
  url: string | null;
  contextItemId: string | null;
  /** The person's own instructions, and whether it's about their work or someone else's. */
  instructions: string | null;
  stance: Stance;
  /** What web research found: its links, and which of the person's hints it confirmed. */
  research: { summary: string; sources: { url: string; title: string }[]; hints: BriefResearch["hints"] } | null;
};

/** Where each draft came from (its brief's mode and material), keyed by brief id. */
export async function draftSources(db: Db, orgId: string, briefIds: (string | null)[]): Promise<Map<string, DraftSource>> {
  const ids = [...new Set(briefIds.filter((x): x is string => Boolean(x)))];
  const out = new Map<string, DraftSource>();
  for (const chunk of chunkRows(ids, 2)) {
    const rows = await db
      .select({ id: brief.id, mode: brief.mode, contextItemId: brief.contextItemId, kind: contextItem.kind, title: contextItem.title, url: contextItem.url, instructions: brief.instructions, stance: brief.stance, research: brief.research })
      .from(brief)
      .leftJoin(contextItem, eq(contextItem.id, brief.contextItemId))
      .where(and(eq(brief.orgId, orgId), inArray(brief.id, chunk)));
    for (const r of rows)
      out.set(r.id, {
        mode: r.mode,
        kind: r.kind,
        title: r.title,
        url: r.url,
        contextItemId: r.contextItemId,
        instructions: r.instructions,
        stance: r.stance,
        research: r.research ? { summary: r.research.summary, sources: r.research.sources, hints: r.research.hints } : null,
      });
  }
  return out;
}

export async function getDraft(db: Db, orgId: string, id: string) {
  const [row] = await db.select().from(draft).where(and(eq(draft.orgId, orgId), eq(draft.id, id)));
  return row ?? null;
}

/** Status changes a user may make directly. Publishing states are set by the publisher. */
const USER_TRANSITIONS: Partial<Record<DraftStatus, DraftStatus[]>> = {
  draft: ["approved", "discarded"],
  approved: ["draft", "discarded"],
  failed: ["draft", "discarded"],
  discarded: ["draft"],
  scheduled: ["approved", "discarded"],
};

export class DraftStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftStateError";
  }
}

export async function updateDraft(db: Db, orgId: string, id: string, patch: { text?: string; parts?: string[] | null; status?: DraftStatus }) {
  const current = await getDraft(db, orgId, id);
  if (!current) return null;
  if (current.status === "published" || current.status === "publishing") throw new DraftStateError("Published posts can't be edited here.");
  const set: Partial<typeof draft.$inferInsert> = { updatedAt: new Date() };
  if (patch.parts !== undefined || patch.text !== undefined) {
    // Parts (a thread) win over text; sending text alone makes it a single post again.
    const parts = patch.parts && patch.parts.length > 1 ? patch.parts.map((p) => p.trim()) : null;
    if (parts && !THREAD_PLATFORMS.includes(current.platform)) throw new DraftStateError("This platform doesn't support threads.");
    const text = parts ? joinParts(parts) : patch.parts?.length === 1 ? patch.parts[0]!.trim() : (patch.text ?? current.text);
    set.text = text;
    set.parts = parts;
    set.postedParts = null;
    set.issues = lintDraft(current.platform, text, parts, current.platform === "x" && (await xLongAllowed(db, orgId)));
    set.aiGenerated = true; // Still AI-assisted even after human edits.
  }
  if (patch.status && patch.status !== current.status) {
    if (!USER_TRANSITIONS[current.status]?.includes(patch.status)) {
      throw new DraftStateError(`A ${current.status} post can't be moved to ${patch.status}.`);
    }
    const issues = set.issues ?? current.issues;
    if (patch.status === "approved" && issues.some((i) => i.severity === "error")) {
      throw new DraftStateError("Fix the errors on this post before approving it.");
    }
    set.status = patch.status;
    if (patch.status !== "scheduled") {
      set.scheduledAt = null;
      set.autoScheduled = false;
    }
  }
  // Guard against concurrent edits changing a post that just started publishing.
  await db
    .update(draft)
    .set(set)
    .where(and(eq(draft.orgId, orgId), eq(draft.id, id), inArray(draft.status, ["draft", "approved", "failed", "discarded", "scheduled"])));
  return getDraft(db, orgId, id);
}

/** An uploaded photo or document, turned into text, as material to write from. */
export async function addUploadedContext(db: Db, orgId: string, input: { kind: "photo" | "document"; title: string; body: string; mediaKey: string | null }) {
  const [row] = await db
    .insert(contextItem)
    .values({ id: newId("ctx"), orgId, kind: input.kind, title: input.title.slice(0, 300), body: input.body.slice(0, 20_000), mediaKey: input.mediaKey })
    .returning({ id: contextItem.id, title: contextItem.title });
  return row!;
}

/** Uploads today (per workspace), to cap image reading cost. */
export async function uploadsToday(db: Db, orgId: string, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const rows = await db
    .select({ id: contextItem.id })
    .from(contextItem)
    .where(and(eq(contextItem.orgId, orgId), inArray(contextItem.kind, ["photo", "document"]), gte(contextItem.createdAt, start)));
  return rows.length;
}
