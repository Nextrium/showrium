// How good an idea is, without AI (owner decision 2026-10-18). A stored base score (what it is, how
// relevant, how noisy) plus freshness worked out when it's read, so ideas fade as they age.
//   below 40: hidden from Ideas (still under "Show all")
//   a passion's idea below 55: set aside automatically (owner decision 2026-10-21), until brought back
//   60+ and fresh: automation may write from it
//   75+ and at most 48 hours old: "Approve for me" may approve it (posts are always scheduled, never sent at once)

export const IDEA_SHOW_MIN = 40;
export const IDEA_WRITE_MIN = 60;
export const IDEA_APPROVE_MIN = 75;
/** A passion's ideas under this are set aside, so only the ones worth posting are kept (owner decision 2026-10-21). */
export const IDEA_PASSION_KEEP_MIN = 55;

const DAY = 86_400_000;
const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "your", "you", "are", "was", "has", "have", "new", "how", "why", "what", "our", "its", "into", "about", "will", "can", "now", "out", "all"]);

/** Whether the material is the person's own (their repos, blog, notes) or from outside (a passion's sources). */
export type IdeaOrigin = "own" | "outside";

const words = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) ?? []).filter((w) => w.length >= 3 && !STOP.has(w));
const has = (text: string, term: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "iu").test(text);

const PRERELEASE = /\b(rc[\s.-]?\d*|beta|alpha|nightly|pre-?release|preview|snapshot|canary)\b/i;
const DIGEST = /\b(weekly|monthly|daily)\s+(digest|roundup|round-up|recap|newsletter)\b|\bsponsored\b|\bnewsletter\s*#?\d+\b/i;
// Merged pull requests are real work; merging branches, bumps and tidying aren't.
const CHORE = /^-\s*(merge branch|bump|chore|deps?\b|build\(deps|ci\b|lint|format|typo|fix typo|update (readme|changelog|dependencies))/i;

/**
 * The base score (0 to 100): what kind of material it is, plus signals, relevance to the person's
 * interests (or the passion), minus noise. Freshness is added when it's read (see effectiveScore).
 */
export function baseScore(input: { kind: string; title: string; body?: string; keywords?: string[]; passionName?: string | null }): number {
  const { kind, title } = input;
  const text = `${title}\n${(input.body ?? "").slice(0, 1000)}`;
  let score = kind === "github_release" ? 60 : kind === "github_activity" ? 50 : kind === "rss_item" ? 45 : 55;
  if (/\bv?\d+\.\d+(\.\d+)?\b/.test(title)) score += 10;
  if (/\b(launch|launched|release|released|ship|shipped|announce|announced|introducing)\b/i.test(title)) score += 10;
  // Relevance: the person's interests and expertise (from Brand voice).
  const terms = [...new Set((input.keywords ?? []).map((k) => k.trim().toLowerCase()).filter((k) => k.length >= 3))];
  score += Math.min(15, terms.filter((t) => has(text, t)).length * 5);
  // A passion's item that never mentions it is probably off-topic (broad news sites).
  if (input.passionName) {
    const name = words(input.passionName);
    if (name.length && !name.some((w) => has(text, w))) score -= 20;
  }
  // Noise.
  // Strong enough that even a fresh one stays out of automation (pre-releases) or out of sight (digests).
  if (PRERELEASE.test(title)) score -= 30;
  if (DIGEST.test(title)) score -= 30;
  if (kind === "github_activity") {
    const lines = (input.body ?? "").split("\n").filter((l) => l.startsWith("- "));
    if (lines.length && lines.every((l) => CHORE.test(l))) score -= 20;
  }
  return Math.max(0, Math.min(100, score));
}

/** How old the material is: its publish date if the source gave one, else when Showrium found it. */
export const ageOf = (publishedAt: Date | null | undefined, foundAt: Date, now = new Date()) => Math.max(0, now.getTime() - (publishedAt ?? foundAt).getTime());

export function freshnessBonus(age: number): number {
  return age <= DAY ? 20 : age <= 3 * DAY ? 10 : age <= 7 * DAY ? 0 : -30;
}

export function effectiveScore(base: number, age: number): number {
  return Math.max(0, Math.min(100, base + freshnessBonus(age)));
}

/** Too old to bother with: outside news after 14 days, the person's own material after 30. */
export function isStale(age: number, origin: IdeaOrigin): boolean {
  return age > (origin === "outside" ? 14 : 30) * DAY;
}

/** Automation may write posts from it. */
export function isWritable(score: number, age: number, origin: IdeaOrigin): boolean {
  return score >= IDEA_WRITE_MIN && age <= (origin === "outside" ? 3 : 14) * DAY;
}

/** "Approve for me" may approve its posts (then they're scheduled, with a notification to cancel). */
export function isApprovable(score: number, age: number): boolean {
  return score >= IDEA_APPROVE_MIN && age <= 2 * DAY;
}

// --- Time-sensitive posts (owner decision 2026-10-19) ---------------------------------------------

const HOUR = 3_600_000;
/** How long a post stays worth posting, from when its material was published. */
export const GOOD_FOR = { outsideNews: 48 * HOUR, ownRelease: 7 * DAY, evergreen: 30 * DAY };
/** Extra posts automation may write per day for urgent news, beyond its daily number (they wait for the person). */
export const URGENT_EXTRA_PER_DAY = 2;
/** "Needs you" emails per workspace per day, and the quiet hours (local time) when none are sent. */
export const NEEDS_YOU_ALERTS_PER_DAY = 3;
export const QUIET_HOURS = { from: 22, to: 7 };

/**
 * When a post stops being worth posting: news from outside 48 hours after it was published; the
 * person's own releases and blog posts after 7 days; notes, photos and evergreen material after 30.
 */
export function goodUntil(kind: string, origin: IdeaOrigin, publishedAt: Date | null | undefined, foundAt: Date): Date {
  const from = (publishedAt ?? foundAt).getTime();
  const span = origin === "outside" ? GOOD_FOR.outsideNews : kind === "github_release" || kind === "rss_item" ? GOOD_FOR.ownRelease : GOOD_FOR.evergreen;
  return new Date(from + span);
}

const URGENT_WORDS = /\b(launch(?:ed|es)?|announc(?:e|ed|es|ement)|live now|now live|today|tonight|this week|vote|voting|deadline|ends?|ending|last chance|breaking|just (?:released|shipped|dropped)|out now)\b/i;

/**
 * Time-sensitive: strong (75+), published in the last 24 hours, and either news from outside (a
 * passion) or worded as happening now. The person's own releases keep for a week, so they can wait.
 */
export function isUrgent(input: { score: number; age: number; origin: IdeaOrigin; kind: string; title: string }): boolean {
  if (input.score < IDEA_APPROVE_MIN || input.age > DAY) return false;
  return input.origin === "outside" || URGENT_WORDS.test(input.title);
}

/** Within the quiet hours in this timezone (no "needs you" emails then; they wait for the morning). */
export function inQuietHours(hour: number): boolean {
  return hour >= QUIET_HOURS.from || hour < QUIET_HOURS.to;
}

/** Two titles about the same story (word overlap), so the same news from several sources is one idea. */
export function sameStory(a: string, b: string): boolean {
  const x = new Set(words(a));
  const y = new Set(words(b));
  if (x.size < 3 || y.size < 3) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared) >= 0.6;
}
