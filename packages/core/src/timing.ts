// When automation posts: in the person's timezone, inside their posting windows (morning, midday,
// afternoon, evening), at most one post per window and at least 4 hours apart on an account, within
// each platform's daily limit. The exact minute is random inside the window, and which window gets
// the next post is learned from how earlier posts did (Thompson sampling over the windows: mostly
// the best one, sometimes another, less often as the evidence grows). Every function is pure or
// filters by orgId.
import { and, eq, gte, inArray, isNotNull, or } from "drizzle-orm";
import { draft, postMetrics, type Db, type Platform } from "@nextrium/db";

export const WINDOWS = {
  morning: { start: 7, end: 10 },
  midday: { start: 11, end: 14 },
  afternoon: { start: 15, end: 18 },
  evening: { start: 19, end: 22 },
} as const;
export type PostingWindow = keyof typeof WINDOWS;
export const WINDOW_NAMES = Object.keys(WINDOWS) as PostingWindow[];

/** The most posts a day automation may make per account (owner decision 2026-10-16; spam rules). */
export const PLATFORM_DAILY_MAX: Record<Platform, number> = {
  x: 5,
  bluesky: 3,
  threads: 3,
  mastodon: 3,
  linkedin: 2,
  facebook: 2,
  instagram: 1,
  tiktok: 1,
  youtube_shorts: 1,
};
export const MIN_GAP_MS = 4 * 3_600_000;
const LEAD_MS = 2 * 3_600_000; // time to look at a post before it goes out
const MINUTE = 60_000;

// --- Timezones ---------------------------------------------------------------------------------

export function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** Local calendar parts of an instant in a timezone. */
export function localParts(at: Date, tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday ?? "");
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), weekday };
}

/** The instant of a local wall-clock time in a timezone (handles daylight saving). */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const want = Date.UTC(year, month - 1, day, hour, minute);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess), tz);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += want - seen;
  }
  return new Date(guess);
}

/** Which window a local hour falls in (null outside them). */
export function windowOf(hour: number): PostingWindow | null {
  return WINDOW_NAMES.find((w) => hour >= WINDOWS[w].start && hour < WINDOWS[w].end) ?? null;
}

/** "YYYY-MM-DD" of the local day. */
export const localDay = (at: Date, tz: string) => {
  const p = localParts(at, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};

// --- Learning ------------------------------------------------------------------------------------

export type WindowStats = Partial<Record<PostingWindow, { n: number; mean: number }>>;

/** A post's engagement in one number: replies count most, then reposts, then likes. */
export const engagementScore = (m: { likes: number; replies: number; reposts: number }) => m.likes + 2 * m.reposts + 3 * m.replies;

/**
 * How well each window has done for one platform, from published posts with metrics (last 120 days).
 * Scores are relative to the account's own median, so small and big accounts learn the same way.
 */
export async function learnWindows(db: Db, orgId: string, platform: Platform, tz: string, now = new Date()): Promise<WindowStats> {
  const rows = await db
    .select({ at: draft.publishedAt, likes: postMetrics.likes, replies: postMetrics.replies, reposts: postMetrics.reposts })
    .from(draft)
    .innerJoin(postMetrics, eq(postMetrics.draftId, draft.id))
    .where(and(eq(draft.orgId, orgId), eq(draft.platform, platform), eq(draft.status, "published"), isNotNull(draft.publishedAt), gte(draft.publishedAt, new Date(now.getTime() - 120 * 86_400_000))))
    .limit(500);
  return statsFrom(rows.flatMap((r) => (r.at ? [{ at: r.at, score: engagementScore(r) }] : [])), tz);
}

export function statsFrom(posts: { at: Date; score: number }[], tz: string): WindowStats {
  if (!posts.length) return {};
  const sorted = posts.map((p) => p.score).sort((a, b) => a - b);
  const median = Math.max(1, sorted[Math.floor(sorted.length / 2)]!);
  const acc: Partial<Record<PostingWindow, { n: number; sum: number }>> = {};
  for (const p of posts) {
    const w = windowOf(localParts(p.at, tz).hour);
    if (!w) continue;
    const a = (acc[w] ??= { n: 0, sum: 0 });
    a.n++;
    a.sum += p.score / median;
  }
  return Object.fromEntries(Object.entries(acc).map(([w, a]) => [w, { n: a!.n, mean: a!.sum / a!.n }])) as WindowStats;
}

/** A draw for a window: around its average, wider when there's little evidence (prior: average 1). */
function sample(stats: WindowStats, w: PostingWindow, rand: () => number): number {
  const s = stats[w] ?? { n: 0, mean: 1 };
  const mean = (s.mean * s.n + 1) / (s.n + 1); // one imaginary average post keeps early guesses calm
  const sd = 1 / Math.sqrt(s.n + 1);
  const u = Math.max(1e-9, rand());
  const v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** The best learned window and how many posts it's based on (for showing the person). */
export function bestWindow(stats: WindowStats): { window: PostingWindow; posts: number } | null {
  const entries = Object.entries(stats) as [PostingWindow, { n: number; mean: number }][];
  const total = entries.reduce((a, [, s]) => a + s.n, 0);
  if (total < 5) return null; // not enough to say yet
  const [window] = entries.sort((a, b) => b[1].mean - a[1].mean)[0]!;
  return { window, posts: total };
}

// --- Choosing the slot ---------------------------------------------------------------------------

export type SlotInput = {
  now: Date;
  tz: string;
  /** Days to post on, 0 = Sunday (in the person's timezone). */
  days: number[];
  windows: PostingWindow[];
  perDay: number;
  /** Other posts on this account (scheduled or published), to keep apart. */
  taken: Date[];
  stats: WindowStats;
  rand?: () => number;
  /** Never later than this (a post's "good until"): past it, no slot is found and the person is asked instead. */
  notAfter?: Date | null | undefined;
};

/**
 * The next posting time for an account: the first local day with a free window, and on that day the
 * window the learning prefers, at a random minute inside it. Null if nothing fits in two weeks.
 */
export function pickSlot(input: SlotInput): Date | null {
  const rand = input.rand ?? Math.random; // timing jitter only, never used for anything secret
  const windows = input.windows.length ? input.windows : WINDOW_NAMES;
  const today = localParts(input.now, input.tz);
  for (let d = 0; d < 14; d++) {
    const base = zonedTime(today.year, today.month, today.day + d, 12, 0, input.tz); // noon avoids DST edges
    if (input.notAfter && base.getTime() - 12 * 3_600_000 > input.notAfter.getTime()) break; // the whole day is too late
    const day = localParts(base, input.tz);
    if (!input.days.includes(day.weekday)) continue;
    const dayKey = `${day.year}-${day.month}-${day.day}`;
    const sameDay = input.taken.filter((t) => {
      const p = localParts(t, input.tz);
      return `${p.year}-${p.month}-${p.day}` === dayKey;
    });
    if (sameDay.length >= input.perDay) continue;
    const usedWindows = new Set(sameDay.map((t) => windowOf(localParts(t, input.tz).hour)));
    const options: { at: Date; score: number }[] = [];
    for (const w of windows) {
      if (usedWindows.has(w)) continue;
      const { start, end } = WINDOWS[w];
      // A random minute in the window, leaving 15 minutes at the end.
      const offset = Math.floor(rand() * ((end - start) * 60 - 15));
      const at = zonedTime(day.year, day.month, day.day, start, 0, input.tz);
      const when = new Date(at.getTime() + offset * MINUTE);
      if (when.getTime() < input.now.getTime() + LEAD_MS) continue;
      if (input.notAfter && when.getTime() > input.notAfter.getTime()) continue;
      if (input.taken.some((t) => Math.abs(t.getTime() - when.getTime()) < MIN_GAP_MS)) continue;
      options.push({ at: when, score: sample(input.stats, w, rand) });
    }
    if (options.length) return options.sort((a, b) => b.score - a.score)[0]!.at;
  }
  return null;
}

/** Scheduled and published times on an account (last day to two weeks ahead), for pickSlot. */
export async function takenTimes(db: Db, orgId: string, connectionId: string, now: Date): Promise<Date[]> {
  const rows = await db
    .select({ scheduledAt: draft.scheduledAt, publishedAt: draft.publishedAt })
    .from(draft)
    .where(and(eq(draft.orgId, orgId), eq(draft.connectionId, connectionId), inArray(draft.status, ["scheduled", "publishing", "published"]), or(gte(draft.scheduledAt, new Date(now.getTime() - 86_400_000)), gte(draft.publishedAt, new Date(now.getTime() - 86_400_000)))));
  return rows.flatMap((r) => [r.scheduledAt, r.publishedAt].filter((d): d is Date => Boolean(d)));
}
