// Automation you can combine: independent switches per platform (write drafts, schedule when
// approved, approve for me), a balance of styles, posts per day per platform, and the days and
// windows to post in, in the person's timezone (v2, 2026-10-17). Posting times are learned from
// engagement (timing.ts); repeats are flagged (repetition.ts). Every function filters by orgId.
// Replies, likes, follows and messages are never automated.
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  autopilot,
  CONTENT_MODES,
  connection,
  contextItem,
  draft,
  idea,
  source,
  persona,
  type AutomationRule,
  type AutopilotLevel,
  type ContentMode,
  type Db,
  type Platform,
} from "@nextrium/db";
import { hasErrors } from "@nextrium/policy";
import type { Provider } from "@nextrium/llm";
import { composeIdea } from "./autonomy.js";
import { getOrgLimits, getOrgPlan } from "./content.js";
import { recordAudit } from "./orgs.js";
import { sourceIsLive, utcDay } from "./passions.js";
import { ageOf, effectiveScore, isApprovable, isWritable } from "./idea-score.js";
import { getUsage, PLAN_FEATURES, type Plan } from "./plans.js";
import { API_PUBLISH_PLATFORMS, scheduleDraft } from "./publishing.js";
import { isTimezone, learnWindows, localDay, localParts, pickSlot, PLATFORM_DAILY_MAX, takenTimes, windowOf, WINDOW_NAMES, type PostingWindow } from "./timing.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
/** The style balance: each style's share, 0 to 10. */
const MAX_WEIGHT = 10;

/**
 * Platforms automation never approves. Empty since 2026-10-18: X's automation rules allow automated
 * original posts with the user's express consent (asked once, see saveAutopilot) and an instant opt-out.
 */
export const AUTOPILOT_EXCLUDED: Platform[] = [];
/** Only material the person produced may be approved without them: not ideas shaped by strangers' comments. */
const TRUSTED_KINDS = ["github_release", "github_activity", "rss_item", "photo", "document", "prompt", "voice", "manual"];

export type Automation = {
  findIdeas: boolean;
  rules: Partial<Record<Platform, AutomationRule>>;
  mix: Partial<Record<ContentMode, number>>;
  days: number[];
  publishHourUtc: number;
  timezone: string;
  windows: PostingWindow[];
  perDay: Partial<Record<Platform, number>>;
  /** Email the owners when automation approves and schedules posts. Kept as saved when left out. */
  notifyEmail?: boolean | undefined;
  /** The person agrees that automation may approve X posts (asked once; switching X off clears it). */
  xConsent?: boolean | undefined;
};
/** The earlier single-level settings; still accepted by the API. */
export type LegacyAutopilot = { level: AutopilotLevel; mode: ContentMode; platforms: Platform[]; postsPerWeek: number; publishHourUtc: number };

export class AutopilotError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "plan_required" | "x_consent_required" = "invalid",
  ) {
    super(message);
    this.name = "AutopilotError";
  }
}

// --- Plans ------------------------------------------------------------------------------------

/** What each plan allows: Free/Lite find ideas; Starter adds writing and scheduling; Creator+ adds "approve for me". */
export function allowedSwitches(plan: Plan) {
  const level = PLAN_FEATURES[plan].autopilot;
  return { write: level !== "coach", schedule: level !== "coach", approve: level === "autopilot" };
}

/** The most any platform does, kept in the `level` column for the scheduler and older clients. */
export function levelOf(rules: Automation["rules"]): AutopilotLevel {
  const all = Object.values(rules);
  if (all.some((r) => r?.write && r.approve)) return "autopilot";
  if (all.some((r) => r?.write && r.schedule)) return "batch";
  if (all.some((r) => r?.write)) return "drafts";
  return "coach";
}

export function fromLegacy(l: LegacyAutopilot): Omit<Automation, "findIdeas" | "days" | "timezone" | "windows" | "perDay"> {
  const full = l.level === "autopilot";
  const write = l.level !== "coach";
  // The old full autopilot never posted to X, so X keeps only "write drafts".
  // The old single level never covered X (its approval now needs explicit consent): X stays hands-on.
  const rules = Object.fromEntries(l.platforms.map((p) => [p, { write, schedule: full && p !== "x", approve: full && p !== "x" }]));
  return { rules, mix: { [l.mode]: l.postsPerWeek }, publishHourUtc: l.publishHourUtc };
}

/** Saves settings sent in the earlier single-level shape. */
export async function saveLegacyAutopilot(db: Db, orgId: string, l: LegacyAutopilot) {
  if (l.level !== "coach" && !l.platforms.length) throw new AutopilotError("Choose at least one platform for autopilot.");
  const current = await getAutopilot(db, orgId);
  return saveAutopilot(db, orgId, { ...fromLegacy(l), findIdeas: current.findIdeas, days: current.days, timezone: current.timezone, windows: current.windows, perDay: current.perDay });
}

const total = (mix: Automation["mix"]) => Object.values(mix).reduce<number>((a, b) => a + (b ?? 0), 0);

/** Posts per day for each platform that writes: the saved number, at least 1, within the platform's limit. */
function perDayFor(rules: Automation["rules"], saved: Partial<Record<Platform, number>>): Partial<Record<Platform, number>> {
  const out: Partial<Record<Platform, number>> = {};
  for (const p of Object.keys(rules) as Platform[]) {
    if (!rules[p]?.write && !rules[p]?.schedule) continue;
    out[p] = Math.min(PLATFORM_DAILY_MAX[p], Math.max(1, Math.round(saved[p] ?? 1)));
  }
  return out;
}

// --- Settings -----------------------------------------------------------------------------------

export async function getAutopilot(db: Db, orgId: string) {
  const [row] = await db.select().from(autopilot).where(eq(autopilot.orgId, orgId));
  if (!row) {
    return {
      findIdeas: true,
      rules: {},
      mix: { build_in_public: 3 },
      days: ALL_DAYS,
      publishHourUtc: 14,
      timezone: "UTC",
      windows: [...WINDOW_NAMES],
      perDay: {} as Partial<Record<Platform, number>>,
      notifyEmail: true,
      xConsentAt: null as Date | null,
      level: "coach" as AutopilotLevel,
      mode: "build_in_public" as ContentMode,
      platforms: [] as Platform[],
      postsPerWeek: 3,
      lastRunAt: null as Date | null,
    };
  }
  // Rows saved before Sprint 3 have only the single level: read them as switches.
  const legacy = Object.keys(row.rules).length === 0 && row.level !== "coach";
  const converted = legacy ? fromLegacy({ level: row.level, mode: row.mode, platforms: row.platforms, postsPerWeek: row.postsPerWeek, publishHourUtc: row.publishHourUtc }) : null;
  const rules = converted?.rules ?? row.rules;
  const mix = Object.keys(row.mix).length ? row.mix : { [row.mode]: row.postsPerWeek };
  return {
    findIdeas: row.findIdeas,
    rules,
    mix,
    days: row.days.length ? row.days : ALL_DAYS,
    publishHourUtc: row.publishHourUtc,
    timezone: isTimezone(row.timezone) ? row.timezone : "UTC",
    windows: (row.windows.length ? row.windows : WINDOW_NAMES) as PostingWindow[],
    perDay: perDayFor(rules, row.perDay),
    notifyEmail: row.notifyEmail,
    xConsentAt: row.xConsentAt,
    level: levelOf(rules),
    mode: row.mode,
    platforms: (Object.keys(rules) as Platform[]).filter((p) => rules[p]?.write),
    postsPerWeek: total(mix),
    lastRunAt: row.lastRunAt,
  };
}

export async function saveAutopilot(db: Db, orgId: string, input: Automation) {
  const [p] = await db.select({ safe: persona.monetizationSafe, platforms: persona.platforms }).from(persona).where(eq(persona.orgId, orgId));
  const rules: Automation["rules"] = {};
  for (const [platform, r] of Object.entries(input.rules) as [Platform, AutomationRule][]) {
    // Keep only switches that are on; "approve" and "schedule" need "write" to matter for automation,
    // except "schedule", which also applies to posts you approve yourself.
    if (r.write || r.schedule || r.approve) rules[platform] = { write: r.write, schedule: r.schedule, approve: r.approve && r.write };
  }
  const used = Object.keys(rules) as Platform[];
  if (used.length) {
    if (!p) throw new AutopilotError("Set up your voice first.");
    const outside = used.filter((x) => !p.platforms.includes(x));
    if (outside.length) throw new AutopilotError(`Add ${outside.join(", ")} to your platforms in Brand voice first.`);
  }
  if (used.some((x) => AUTOPILOT_EXCLUDED.includes(x) && rules[x]!.approve)) {
    throw new AutopilotError("Automation can't approve posts on this platform. You can still schedule posts you approve.");
  }
  // X: automated posting needs the person's express consent (X's automation rules), asked once.
  const [current] = await db.select({ xConsentAt: autopilot.xConsentAt, notifyEmail: autopilot.notifyEmail }).from(autopilot).where(eq(autopilot.orgId, orgId));
  if (rules.x?.approve && !current?.xConsentAt && !input.xConsent) {
    throw new AutopilotError("Agree first: automation will approve X posts and schedule them on your X account (never replies, mentions or messages). You'll be told before each goes out, and switching this off stops it at once.", "x_consent_required");
  }
  if (p?.safe && used.some((x) => rules[x]!.approve)) {
    throw new AutopilotError("Monetization-safe mode needs your approval on every post, so \"approve for me\" is off. Use \"schedule when approved\" instead.");
  }
  const plan = await getOrgPlan(db, orgId);
  const allowed = allowedSwitches(plan);
  const wants = { write: used.some((x) => rules[x]!.write), schedule: used.some((x) => rules[x]!.schedule), approve: used.some((x) => rules[x]!.approve) };
  const blocked = (["write", "schedule", "approve"] as const).find((k) => wants[k] && !allowed[k]);
  if (blocked) {
    const names = { write: "Writing drafts", schedule: "Scheduling", approve: "\"Approve for me\"" };
    throw new AutopilotError(`${names[blocked]} isn't included in the ${plan} plan. Upgrade in Billing.`, "plan_required");
  }

  const mix: Automation["mix"] = {};
  for (const m of CONTENT_MODES) {
    const n = Math.round(input.mix[m] ?? 0);
    if (n > 0) mix[m] = Math.min(MAX_WEIGHT, n);
  }
  if (wants.write && total(mix) < 1) throw new AutopilotError("Choose at least one style.");
  if (!isTimezone(input.timezone)) throw new AutopilotError("Choose a valid timezone.");
  const windows = WINDOW_NAMES.filter((w) => input.windows.includes(w));
  if (!windows.length) throw new AutopilotError("Choose at least one time of day to post.");
  for (const [platform, n] of Object.entries(input.perDay) as [Platform, number][]) {
    if (n > PLATFORM_DAILY_MAX[platform]) throw new AutopilotError(`${platform} allows up to ${PLATFORM_DAILY_MAX[platform]} automated post${PLATFORM_DAILY_MAX[platform] === 1 ? "" : "s"} a day.`);
  }
  // More posts a day than chosen windows can't fit (one post per window).
  const perDay = perDayFor(rules, input.perDay);
  const most = Math.max(0, ...Object.values(perDay).map((n) => n ?? 0));
  if (most > windows.length) throw new AutopilotError(`${most} posts a day need at least ${most} times of day (one post per time of day).`);
  const days = [...new Set(input.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  if (!days.length) throw new AutopilotError("Choose at least one day to post on.");

  const top = (Object.entries(mix) as [ContentMode, number][]).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "build_in_public";
  const values = {
    findIdeas: input.findIdeas,
    rules,
    mix,
    days,
    publishHourUtc: Math.min(23, Math.max(0, Math.round(input.publishHourUtc))),
    timezone: input.timezone,
    windows,
    perDay,
    notifyEmail: input.notifyEmail ?? current?.notifyEmail ?? true,
    // Consent is kept while X approval stays on, and cleared when it's switched off (asked again next time).
    xConsentAt: rules.x?.approve ? (current?.xConsentAt ?? new Date()) : null,
    level: levelOf(rules),
    // Legacy columns, kept in step for older clients.
    mode: top,
    platforms: used.filter((x) => rules[x]!.write),
    postsPerWeek: Math.max(1, Object.values(perDay).reduce<number>((a, b) => a + (b ?? 0), 0) * days.length),
  };
  await db.insert(autopilot).values({ orgId, ...values }).onConflictDoUpdate({ target: autopilot.orgId, set: { ...values, updatedAt: new Date() } });
  return getAutopilot(db, orgId);
}

// --- Slots ------------------------------------------------------------------------------------

/** The next posting slot at the chosen hour on an allowed day, at least 2 hours away (time to cancel). */
export function nextSlot(now: Date, hourUtc: number, days: number[] = ALL_DAYS): Date {
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc));
  for (let i = 0; i < 15; i++) {
    if (slot.getTime() >= now.getTime() + 2 * HOUR && days.includes(slot.getUTCDay())) return slot;
    slot.setUTCDate(slot.getUTCDate() + 1);
  }
  return slot;
}

/** The next posting time on an account: in a free window, learned from engagement (see timing.ts). */
async function nextWindowSlot(db: Db, orgId: string, conn: { id: string; platform: Platform }, now: Date, s: Awaited<ReturnType<typeof getAutopilot>>, rand?: () => number) {
  const [taken, stats] = await Promise.all([takenTimes(db, orgId, conn.id, now), learnWindows(db, orgId, conn.platform, s.timezone, now)]);
  return pickSlot({ now, tz: s.timezone, days: s.days, windows: s.windows, perDay: s.perDay[conn.platform] ?? 1, taken, stats, ...(rand ? { rand } : {}) });
}

/**
 * "Schedule when approved": approved posts on platforms with that switch on go to the next free
 * slot on a connected account. Called after any approval (by you, in a batch, or by automation).
 * Posts that can't be scheduled (no connection, not an API platform, errors) stay approved.
 */
export async function autoScheduleApproved(db: Db, orgId: string, draftIds: string[], now = new Date()) {
  return (await autoScheduleApprovedIds(db, orgId, draftIds, now)).length;
}

/** autoScheduleApproved, returning the ids that were scheduled (for notifications). */
export async function autoScheduleApprovedIds(db: Db, orgId: string, draftIds: string[], now = new Date()): Promise<string[]> {
  if (!draftIds.length) return [];
  const s = await getAutopilot(db, orgId);
  const plan = await getOrgPlan(db, orgId);
  if (!allowedSwitches(plan).schedule) return [];
  const rows = await db
    .select({ id: draft.id, platform: draft.platform, status: draft.status, issues: draft.issues, connectionId: draft.connectionId })
    .from(draft)
    .where(and(eq(draft.orgId, orgId), inArray(draft.id, draftIds.slice(0, 50)), eq(draft.status, "approved")));
  const conns = await db.select({ id: connection.id, platform: connection.platform }).from(connection).where(and(eq(connection.orgId, orgId), eq(connection.status, "active")));
  const scheduled: string[] = [];
  for (const d of rows) {
    if (!s.rules[d.platform]?.schedule || hasErrors(d.issues)) continue;
    const conn = conns.find((c) => c.id === d.connectionId) ?? conns.find((c) => c.platform === d.platform && API_PUBLISH_PLATFORMS.includes(c.platform));
    if (!conn || !API_PUBLISH_PLATFORMS.includes(conn.platform)) continue;
    try {
      const at = await nextWindowSlot(db, orgId, conn, now, s);
      if (!at) continue; // nothing free in the next two weeks: stays approved
      await scheduleDraft(db, orgId, d.id, { at, connectionId: conn.id, auto: true });
      scheduled.push(d.id);
    } catch {
      // Left approved; the person can schedule it by hand.
    }
  }
  return scheduled;
}

// --- Clashes: a post you schedule yourself near another one on the same account ------------------

const CLASH_GAP_MS = 4 * HOUR;

/**
 * Other posts scheduled on this account within 4 hours of `at`, or in the same time of day on the
 * same local day. Automation already keeps clear of everything; this is for times people pick.
 */
export async function findScheduleClashes(db: Db, orgId: string, connectionId: string, at: Date, excludeDraftId?: string) {
  const s = await getAutopilot(db, orgId);
  const rows = await db
    .select({ id: draft.id, scheduledAt: draft.scheduledAt, autoScheduled: draft.autoScheduled, autoApproved: draft.autoApproved, text: draft.text })
    .from(draft)
    .where(and(eq(draft.orgId, orgId), eq(draft.connectionId, connectionId), eq(draft.status, "scheduled"), gte(draft.scheduledAt, new Date(at.getTime() - DAY)), lt(draft.scheduledAt, new Date(at.getTime() + DAY))));
  const local = localParts(at, s.timezone);
  const win = windowOf(local.hour);
  return rows
    .filter((r): r is typeof r & { scheduledAt: Date } => Boolean(r.scheduledAt) && r.id !== excludeDraftId)
    .filter((r) => {
      if (Math.abs(r.scheduledAt.getTime() - at.getTime()) < CLASH_GAP_MS) return true;
      const p = localParts(r.scheduledAt, s.timezone);
      return Boolean(win) && p.year === local.year && p.month === local.month && p.day === local.day && windowOf(p.hour) === win;
    })
    .map((r) => ({ id: r.id, at: r.scheduledAt, auto: r.autoScheduled, text: r.text.slice(0, 140) }));
}

/**
 * Moves automatically scheduled posts to their next free slot (your own post keeps its time). A post
 * with no free slot in the next two weeks goes back to approved, so nothing is posted unexpectedly.
 */
export async function moveAutoScheduled(db: Db, orgId: string, draftIds: string[], now = new Date()) {
  const s = await getAutopilot(db, orgId);
  const moved: { id: string; at: Date | null }[] = [];
  for (const id of draftIds.slice(0, 20)) {
    const [d] = await db
      .update(draft)
      .set({ status: "approved", scheduledAt: null, updatedAt: new Date() })
      .where(and(eq(draft.orgId, orgId), eq(draft.id, id), eq(draft.status, "scheduled"), eq(draft.autoScheduled, true)))
      .returning({ id: draft.id, platform: draft.platform, connectionId: draft.connectionId });
    if (!d?.connectionId) continue;
    const at = await nextWindowSlot(db, orgId, { id: d.connectionId, platform: d.platform }, now, s);
    if (at) await scheduleDraft(db, orgId, d.id, { at, connectionId: d.connectionId, auto: true });
    else await db.update(draft).set({ autoScheduled: false }).where(eq(draft.id, d.id));
    moved.push({ id: d.id, at });
  }
  return moved;
}

// --- The weekly run -------------------------------------------------------------------------------

/**
 * The style that's most behind its share of the last 7 days (the mix is a balance: { teach: 2,
 * smile: 1 } means two teaching posts for each light one). Ties: the order in the mix. Null if empty.
 */
export function pickMode(mix: Automation["mix"], log: { at: number; mode: ContentMode }[], now: Date): ContentMode | null {
  const recent = log.filter((l) => l.at > now.getTime() - 7 * DAY);
  let best: { mode: ContentMode; ratio: number } | null = null;
  for (const m of CONTENT_MODES) {
    const want = mix[m] ?? 0;
    if (!want) continue;
    const ratio = recent.filter((l) => l.mode === m).length / want;
    // Ties go to the style with the bigger share.
    if (!best || ratio < best.ratio || (ratio === best.ratio && want > (mix[best.mode] ?? 0))) best = { mode: m, ratio };
  }
  return best?.mode ?? null;
}

/** Material that suits each style best (used to pick the idea; any idea can be written in any style). */
const SUITS: Record<ContentMode, string[]> = {
  build_in_public: ["github_release", "github_activity"],
  teach: ["rss_item", "document", "url"],
  expert_take: ["rss_item", "url", "manual"],
  smile: ["photo", "prompt", "voice"],
  promote: ["github_release", "url", "manual"],
};

/** Called with each new brief (the worker uses it to find the posts' image). */
export type AfterCompose = (orgId: string, briefId: string) => Promise<unknown>;
/** Called after automation approved and scheduled posts in a run (to tell the person before they go out). */
export type OnAutoScheduled = (orgId: string, draftIds: string[]) => Promise<unknown>;

/** X posts left this month for automation: the plan's allowance minus what's used and what's already scheduled by automation. */
async function xAllowanceLeft(db: Db, orgId: string) {
  const [{ limits }, usage, [pending]] = await Promise.all([
    getOrgLimits(db, orgId),
    getUsage(db, orgId),
    db.select({ n: sql<number>`count(*)` }).from(draft).where(and(eq(draft.orgId, orgId), eq(draft.platform, "x"), eq(draft.autoApproved, true), eq(draft.status, "scheduled"))),
  ]);
  return Math.max(0, limits.xApiPosts - usage.xApiPosts - Number(pending?.n ?? 0));
}

export async function runAutopilotFor(db: Db, providers: Provider[], orgId: string, now = new Date(), afterCompose?: AfterCompose, onScheduled?: OnAutoScheduled) {
  const s = await getAutopilot(db, orgId);
  const plan = await getOrgPlan(db, orgId);
  const allowed = allowedSwitches(plan); // a downgraded plan caps what runs, without changing the saved settings
  if (!allowed.write) return { skipped: "coach" as const };
  const [p] = await db.select({ safe: persona.monetizationSafe, platforms: persona.platforms }).from(persona).where(eq(persona.orgId, orgId));
  if (!p) return { skipped: "no_persona" as const };
  const writing = (Object.keys(s.rules) as Platform[]).filter((x) => s.rules[x]?.write && p.platforms.includes(x));
  if (!writing.length) return { skipped: "no_platforms" as const };

  const [row] = await db.select({ log: autopilot.weekLog }).from(autopilot).where(eq(autopilot.orgId, orgId));
  const log = (row?.log ?? []).filter((l) => l.at > now.getTime() - 7 * DAY);
  // Today's posts per platform (in the person's timezone), and drafts still waiting for review.
  const today = localDay(now, s.timezone);
  const writtenToday = (x: Platform) => log.filter((l) => localDay(new Date(l.at), s.timezone) === today && (l.platforms ?? writing).includes(x)).length;
  const briefIds = log.flatMap((l) => (l.briefId ? [l.briefId] : []));
  const waiting = briefIds.length
    ? await db.select({ platform: draft.platform }).from(draft).where(and(eq(draft.orgId, orgId), inArray(draft.briefId, briefIds), eq(draft.status, "draft")))
    : [];
  // Not on a day off, within each platform's posts per day, and never more than two days of unreviewed drafts.
  const dayOff = !s.days.includes(localParts(now, s.timezone).weekday);
  const platforms = dayOff
    ? []
    : writing.filter((x) => writtenToday(x) < (s.perDay[x] ?? 1) && waiting.filter((w) => w.platform === x).length < 2 * (s.perDay[x] ?? 1));
  if (!platforms.length) return { skipped: dayOff ? ("day_off" as const) : ("daily_limit" as const) };
  // Automation spends only the plan's monthly allowance, never credits.
  if ((await getUsage(db, orgId)).postsGenerated + platforms.length > (await getOrgLimits(db, orgId)).limits.posts) return { skipped: "plan_allowance" as const };
  const mode = pickMode(s.mix, log, now);
  if (!mode) return { skipped: "no_styles" as const };

  const rows = await db
    .select({ id: idea.id, kind: contextItem.kind, base: idea.score, createdAt: idea.createdAt, publishedAt: contextItem.publishedAt, externalId: contextItem.externalId, passionId: source.passionId })
    .from(idea)
    .innerJoin(contextItem, eq(contextItem.id, idea.contextItemId))
    .leftJoin(source, eq(source.id, contextItem.sourceId))
    // Ideas from a passion that's off or outside its dates wait until it's live again.
    .where(and(eq(idea.orgId, orgId), eq(idea.status, "new"), gte(idea.createdAt, new Date(now.getTime() - 30 * DAY)), sourceIsLive(source.passionId, utcDay(now))))
    .orderBy(desc(idea.score), desc(idea.createdAt))
    .limit(100);
  // Only good, fresh ideas (score 60+; outside news at most 3 days old, the person's own material 14).
  const candidates = rows
    .map((c) => {
      const age = ageOf(c.publishedAt, c.createdAt, now);
      return { ...c, age, score: effectiveScore(c.base, age) };
    })
    .filter((c) => isWritable(c.score, c.age, c.passionId ? "outside" : "own"));
  if (!candidates.length) return { skipped: "no_ideas" as const };
  // Best score, with a nudge towards material that suits this week's style.
  const best = candidates.map((c) => ({ ...c, rank: c.score + (SUITS[mode].includes(c.kind) ? 15 : 0) })).sort((a, b) => b.rank - a.rank)[0]!;

  const out = await composeIdea(db, providers, { orgId, ideaId: best.id, mode, platforms });
  await afterCompose?.(orgId, out.briefId).catch(() => undefined);
  await db.update(autopilot).set({ weekLog: [...log, { at: now.getTime(), mode, platforms, briefId: out.briefId }] }).where(eq(autopilot.orgId, orgId));

  // "Approve for me": only clean posts (no errors or warnings), from the person's own material
  // (never ideas shaped by audience comments), never X, and never in monetization-safe mode.
  // Only strong, fresh ideas (75+, at most 48 hours old), never ones shaped by strangers' comments.
  // Passions too (owner decision 2026-10-18): approved posts are always scheduled, with a notification to cancel.
  const trusted = TRUSTED_KINDS.includes(best.kind) && !best.externalId?.startsWith("insight:") && isApprovable(best.score, best.age);
  const approved: string[] = [];
  if (allowed.approve && !p.safe && trusted) {
    for (const d of out.drafts) {
      if (!s.rules[d.platform]?.approve || d.issues.length || AUTOPILOT_EXCLUDED.includes(d.platform)) continue;
      // X: only with consent, and only within the plan's monthly X posts (automation never spends credits).
      if (d.platform === "x" && (!s.xConsentAt || !(await xAllowanceLeft(db, orgId)))) continue;
      await db.update(draft).set({ status: "approved", autoApproved: true, updatedAt: new Date() }).where(and(eq(draft.orgId, orgId), eq(draft.id, d.id), eq(draft.status, "draft")));
      approved.push(d.id);
    }
  }
  const scheduledIds = await autoScheduleApprovedIds(db, orgId, approved, now);
  if (scheduledIds.length) await onScheduled?.(orgId, scheduledIds).catch((error) => console.warn("autopilot notification failed", error instanceof Error ? error.message : error));
  const scheduled = scheduledIds.length;
  await recordAudit(db, { orgId, actorUserId: null, action: "autopilot.run", target: best.id, meta: { mode, drafts: out.drafts.length, approved: approved.length, scheduled } });
  return { ideaId: best.id, mode, drafts: out.drafts.length, approved: approved.length, scheduled };
}

/**
 * Cron: runs workspaces with writing switched on, oldest first, at most every 3 hours each (enough
 * for 5 posts a day; each run writes only for platforms still under their daily number).
 */
export async function runAutopilot(db: Db, providers: Provider[], now = new Date(), limit = 1, afterCompose?: AfterCompose, onScheduled?: OnAutoScheduled) {
  if (!providers.length) return { ran: 0 };
  const cutoff = new Date(now.getTime() - 3 * HOUR);
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
      await runAutopilotFor(db, providers, orgId, now, afterCompose, onScheduled);
      ran++;
    } catch (error) {
      console.warn("autopilot run failed", { orgId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ran };
}
