// Sprint 3: automation you can combine. Independent switches per platform (write drafts, schedule
// when approved, approve for me), a weekly mix of styles, and the days and hour to post.
// Every function filters by orgId. Replies are never automated.
import { and, asc, eq, gte, inArray, isNull, lt, ne, or } from "drizzle-orm";
import {
  autopilot,
  CONTENT_MODES,
  connection,
  contextItem,
  draft,
  idea,
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
import { getOrgPlan } from "./content.js";
import { recordAudit } from "./orgs.js";
import { getUsage, PLAN_FEATURES, PLAN_LIMITS, type Plan } from "./plans.js";
import { API_PUBLISH_PLATFORMS, scheduleDraft } from "./publishing.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const MAX_PER_WEEK = 14;

/** Never approved automatically: X's automation rules. (Scheduling a post you approved is fine.) */
export const AUTOPILOT_EXCLUDED: Platform[] = ["x"];
/** Only material the person produced may be approved without them: not ideas shaped by strangers' comments. */
const TRUSTED_KINDS = ["github_release", "github_activity", "rss_item", "photo", "document", "prompt", "voice", "manual"];

export type Automation = {
  findIdeas: boolean;
  rules: Partial<Record<Platform, AutomationRule>>;
  mix: Partial<Record<ContentMode, number>>;
  days: number[];
  publishHourUtc: number;
};
/** The earlier single-level settings; still accepted by the API. */
export type LegacyAutopilot = { level: AutopilotLevel; mode: ContentMode; platforms: Platform[]; postsPerWeek: number; publishHourUtc: number };

export class AutopilotError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "plan_required" = "invalid",
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

export function fromLegacy(l: LegacyAutopilot): Omit<Automation, "findIdeas" | "days"> {
  const full = l.level === "autopilot";
  const write = l.level !== "coach";
  // The old full autopilot never posted to X, so X keeps only "write drafts".
  const rules = Object.fromEntries(l.platforms.map((p) => [p, { write, schedule: full && !AUTOPILOT_EXCLUDED.includes(p), approve: full && !AUTOPILOT_EXCLUDED.includes(p) }]));
  return { rules, mix: { [l.mode]: l.postsPerWeek }, publishHourUtc: l.publishHourUtc };
}

/** Saves settings sent in the earlier single-level shape. */
export async function saveLegacyAutopilot(db: Db, orgId: string, l: LegacyAutopilot) {
  if (l.level !== "coach" && !l.platforms.length) throw new AutopilotError("Choose at least one platform for autopilot.");
  const current = await getAutopilot(db, orgId);
  return saveAutopilot(db, orgId, { ...fromLegacy(l), findIdeas: current.findIdeas, days: current.days });
}

const total = (mix: Automation["mix"]) => Object.values(mix).reduce<number>((a, b) => a + (b ?? 0), 0);

// --- Settings -----------------------------------------------------------------------------------

export async function getAutopilot(db: Db, orgId: string) {
  const [row] = await db.select().from(autopilot).where(eq(autopilot.orgId, orgId));
  if (!row) {
    return { findIdeas: true, rules: {}, mix: { build_in_public: 3 }, days: ALL_DAYS, publishHourUtc: 14, level: "coach" as AutopilotLevel, mode: "build_in_public" as ContentMode, platforms: [] as Platform[], postsPerWeek: 3, lastRunAt: null as Date | null };
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
    throw new AutopilotError("X doesn't allow automated posting without your approval. You can still schedule X posts you approve.");
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
    if (n > 0) mix[m] = Math.min(MAX_PER_WEEK, n);
  }
  if (wants.write && total(mix) < 1) throw new AutopilotError("Choose at least one post a week in your style mix.");
  if (total(mix) > MAX_PER_WEEK) throw new AutopilotError(`Up to ${MAX_PER_WEEK} posts a week.`);
  const days = [...new Set(input.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  if (!days.length) throw new AutopilotError("Choose at least one day to post on.");

  const top = (Object.entries(mix) as [ContentMode, number][]).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "build_in_public";
  const values = {
    findIdeas: input.findIdeas,
    rules,
    mix,
    days,
    publishHourUtc: Math.min(23, Math.max(0, Math.round(input.publishHourUtc))),
    level: levelOf(rules),
    // Legacy columns, kept in step for older clients.
    mode: top,
    platforms: used.filter((x) => rules[x]!.write),
    postsPerWeek: Math.max(1, total(mix)),
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

/** The next slot with nothing else scheduled on that account, so posts don't bunch up. */
async function nextFreeSlot(db: Db, orgId: string, connectionId: string, now: Date, hourUtc: number, days: number[]) {
  const taken = await db
    .select({ at: draft.scheduledAt })
    .from(draft)
    .where(and(eq(draft.orgId, orgId), eq(draft.connectionId, connectionId), eq(draft.status, "scheduled"), gte(draft.scheduledAt, now)));
  const busy = new Set(taken.map((t) => t.at?.getTime()));
  let slot = nextSlot(now, hourUtc, days);
  for (let i = 0; i < 60 && busy.has(slot.getTime()); i++) slot = nextSlot(new Date(slot.getTime() - 2 * HOUR + 60_000 + DAY), hourUtc, days);
  return slot;
}

/**
 * "Schedule when approved": approved posts on platforms with that switch on go to the next free
 * slot on a connected account. Called after any approval (by you, in a batch, or by automation).
 * Posts that can't be scheduled (no connection, not an API platform, errors) stay approved.
 */
export async function autoScheduleApproved(db: Db, orgId: string, draftIds: string[], now = new Date()) {
  if (!draftIds.length) return 0;
  const s = await getAutopilot(db, orgId);
  const plan = await getOrgPlan(db, orgId);
  if (!allowedSwitches(plan).schedule) return 0;
  const rows = await db
    .select({ id: draft.id, platform: draft.platform, status: draft.status, issues: draft.issues, connectionId: draft.connectionId })
    .from(draft)
    .where(and(eq(draft.orgId, orgId), inArray(draft.id, draftIds.slice(0, 50)), eq(draft.status, "approved")));
  const conns = await db.select({ id: connection.id, platform: connection.platform }).from(connection).where(and(eq(connection.orgId, orgId), eq(connection.status, "active")));
  let scheduled = 0;
  for (const d of rows) {
    if (!s.rules[d.platform]?.schedule || hasErrors(d.issues)) continue;
    const conn = conns.find((c) => c.id === d.connectionId) ?? conns.find((c) => c.platform === d.platform && API_PUBLISH_PLATFORMS.includes(c.platform));
    if (!conn || !API_PUBLISH_PLATFORMS.includes(conn.platform)) continue;
    try {
      await scheduleDraft(db, orgId, d.id, { at: await nextFreeSlot(db, orgId, conn.id, now, s.publishHourUtc, s.days), connectionId: conn.id });
      scheduled++;
    } catch {
      // Left approved; the person can schedule it by hand.
    }
  }
  return scheduled;
}

// --- The weekly run -------------------------------------------------------------------------------

/** The style furthest behind its weekly target (ties: the order in the mix). Null when the week is full. */
export function pickMode(mix: Automation["mix"], log: { at: number; mode: ContentMode }[], now: Date): ContentMode | null {
  const recent = log.filter((l) => l.at > now.getTime() - 7 * DAY);
  let best: { mode: ContentMode; gap: number } | null = null;
  for (const m of CONTENT_MODES) {
    const want = mix[m] ?? 0;
    if (!want) continue;
    const gap = want - recent.filter((l) => l.mode === m).length;
    if (gap > 0 && (!best || gap > best.gap)) best = { mode: m, gap };
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

export async function runAutopilotFor(db: Db, providers: Provider[], orgId: string, now = new Date()) {
  const s = await getAutopilot(db, orgId);
  const plan = await getOrgPlan(db, orgId);
  const allowed = allowedSwitches(plan); // a downgraded plan caps what runs, without changing the saved settings
  if (!allowed.write) return { skipped: "coach" as const };
  const [p] = await db.select({ safe: persona.monetizationSafe, platforms: persona.platforms }).from(persona).where(eq(persona.orgId, orgId));
  if (!p) return { skipped: "no_persona" as const };
  const platforms = (Object.keys(s.rules) as Platform[]).filter((x) => s.rules[x]?.write && p.platforms.includes(x));
  if (!platforms.length) return { skipped: "no_platforms" as const };
  // Automation spends only the plan's monthly allowance, never credits.
  if ((await getUsage(db, orgId)).postsGenerated + platforms.length > PLAN_LIMITS[plan].posts) return { skipped: "plan_allowance" as const };

  const [row] = await db.select({ log: autopilot.weekLog }).from(autopilot).where(eq(autopilot.orgId, orgId));
  const log = (row?.log ?? []).filter((l) => l.at > now.getTime() - 7 * DAY);
  const mode = pickMode(s.mix, log, now);
  if (!mode) return { skipped: "weekly_limit" as const };
  // Spread the week out: with 3 a week, roughly every other day.
  const last = Math.max(0, ...log.map((l) => l.at));
  if (last && now.getTime() - last < Math.min(20 * HOUR, (7 * DAY) / Math.max(1, total(s.mix))) * 0.8) return { skipped: "spacing" as const };

  const candidates = await db
    .select({ id: idea.id, kind: contextItem.kind, score: idea.score, externalId: contextItem.externalId })
    .from(idea)
    .innerJoin(contextItem, eq(contextItem.id, idea.contextItemId))
    .where(and(eq(idea.orgId, orgId), eq(idea.status, "new"), gte(idea.createdAt, new Date(now.getTime() - 30 * DAY))))
    .limit(50);
  if (!candidates.length) return { skipped: "no_ideas" as const };
  // Best score, with a nudge towards material that suits this week's style.
  const best = candidates.map((c) => ({ ...c, rank: c.score + (SUITS[mode].includes(c.kind) ? 15 : 0) })).sort((a, b) => b.rank - a.rank)[0]!;

  const out = await composeIdea(db, providers, { orgId, ideaId: best.id, mode, platforms });
  await db.update(autopilot).set({ weekLog: [...log, { at: now.getTime(), mode }] }).where(eq(autopilot.orgId, orgId));

  // "Approve for me": only clean posts (no errors or warnings), from the person's own material
  // (never ideas shaped by audience comments), never X, and never in monetization-safe mode.
  const trusted = TRUSTED_KINDS.includes(best.kind) && !best.externalId?.startsWith("insight:");
  const approved: string[] = [];
  if (allowed.approve && !p.safe && trusted) {
    for (const d of out.drafts) {
      if (!s.rules[d.platform]?.approve || d.issues.length || AUTOPILOT_EXCLUDED.includes(d.platform)) continue;
      await db.update(draft).set({ status: "approved", updatedAt: new Date() }).where(and(eq(draft.orgId, orgId), eq(draft.id, d.id), eq(draft.status, "draft")));
      approved.push(d.id);
    }
  }
  const scheduled = await autoScheduleApproved(db, orgId, approved, now);
  await recordAudit(db, { orgId, actorUserId: null, action: "autopilot.run", target: best.id, meta: { mode, drafts: out.drafts.length, approved: approved.length, scheduled } });
  return { ideaId: best.id, mode, drafts: out.drafts.length, approved: approved.length, scheduled };
}

/** Cron: runs workspaces with writing switched on, oldest first, at most every 10 hours each. */
export async function runAutopilot(db: Db, providers: Provider[], now = new Date(), limit = 1) {
  if (!providers.length) return { ran: 0 };
  const cutoff = new Date(now.getTime() - 10 * HOUR);
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
