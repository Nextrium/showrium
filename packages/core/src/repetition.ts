// Keeps posts from repeating themselves: the writer is shown how recent posts opened (so it doesn't
// reuse the same hooks and rhetoric), and a new post that's too close to a recent one is flagged,
// which also keeps automation from approving it. Plain word overlap: free, fast and predictable.
import { and, desc, eq, gte, inArray, ne } from "drizzle-orm";
import { draft, type Db, type Platform } from "@nextrium/db";

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** The first line or sentence, shortened: what readers see first. */
export function openingOf(text: string): string {
  const first = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const sentence = first.match(/^.{12,200}?[.!?](\s|$)/)?.[0] ?? first;
  return sentence.trim().slice(0, 160);
}

function shingles(text: string, k = 3): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(" "));
  return out;
}

/** Share of three-word phrases two posts have in common (0 to 1). */
export function overlap(a: string, b: string): number {
  const x = shingles(a);
  const y = shingles(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const s of x) if (y.has(s)) both++;
  return both / (x.size + y.size - both);
}

/** A post's sentences of 6 words or more, normalised (lower case, no punctuation or links), with the original. */
function sentencesOf(text: string): { key: string; text: string }[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .map((s) => ({ key: words(s).join(" "), text: s }))
    .filter((s) => s.key.split(" ").length >= 6);
}

/** Sentences that two or more recent posts share (the same background line in every post, for example). */
export function repeatedSentences(recent: string[], max = 5): string[] {
  const seen = new Map<string, { text: string; posts: number }>();
  for (const r of recent) {
    for (const key of new Set(sentencesOf(r).map((s) => s.key))) {
      const found = seen.get(key);
      seen.set(key, { text: found?.text ?? sentencesOf(r).find((s) => s.key === key)!.text, posts: (found?.posts ?? 0) + 1 });
    }
  }
  return [...seen.values()].filter((s) => s.posts >= 2).slice(0, max).map((s) => s.text);
}

/** Whether a post repeats a recent one: the same opening words, a sentence used before, or many of the same phrases. */
export function repeats(text: string, recent: string[]): { repeated: true; reason: string } | { repeated: false } {
  const open = words(openingOf(text)).slice(0, 6).join(" ");
  const mine = sentencesOf(text);
  for (const r of recent) {
    const used = sentencesOf(r);
    const again = mine.find((s) => used.some((u) => u.key === s.key));
    if (again) return { repeated: true, reason: `It repeats a sentence from a recent post: "${again.text.length > 90 ? `${again.text.slice(0, 90)}…` : again.text}"` };
    if (open.split(" ").length >= 4 && words(openingOf(r)).slice(0, 6).join(" ") === open) return { repeated: true, reason: "It opens the same way as a recent post." };
    if (overlap(text, r) >= 0.35) return { repeated: true, reason: "It repeats much of a recent post's wording." };
  }
  return { repeated: false };
}

/** Recent posts on these platforms (last 30 days, not discarded), newest first. */
export async function recentPosts(db: Db, orgId: string, platforms: Platform[], now = new Date(), limit = 40) {
  if (!platforms.length) return [];
  return db
    .select({ platform: draft.platform, text: draft.text, briefId: draft.briefId })
    .from(draft)
    .where(and(eq(draft.orgId, orgId), inArray(draft.platform, platforms), ne(draft.status, "discarded"), gte(draft.createdAt, new Date(now.getTime() - 30 * 86_400_000))))
    .orderBy(desc(draft.createdAt))
    .limit(limit);
}
