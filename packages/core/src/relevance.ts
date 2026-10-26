// Is a passion's new item about the passion? Two checks run side by side, and either one is enough:
//   words:   it mentions the passion's name, one of its topics, or one of its X accounts' names;
//   meaning: its meaning is closer to the passion than to everyday small talk (an embedding model).
// Neither needs the other: if the model is down, the words still decide; if the words miss (an
// article about ransomware for "CyberSecurity"), the meaning catches it. Items from the passion's own
// sources (an "It's ours" passion, its GitHub repos, its listed X accounts) are never off-topic.
//
// Calibrated on 2026-10-25 with bge-m3 on real items: a margin of -0.12 kept every on-topic security
// and AI item and rejected every piece of small talk (a movie, football, a link with no text). It
// missed subtle items ("$ADA", "Midnight"), which is what topics are for.
import { mentionsTerm } from "./idea-score.js";

/** Turns texts into vectors (one per text, same order). Workers AI in production; a fake in tests. */
export type Embedder = (texts: string[]) => Promise<number[][]>;

export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
/** On-topic by meaning when its similarity to the passion beats its best small-talk similarity by more than this. */
export const MEANING_MARGIN_MIN = -0.12;
/** What off-topic posts tend to be, whatever the passion. Generic on purpose: nothing about any subject. */
export const SMALL_TALK = [
  "personal life, feelings and opinions",
  "small talk, greetings and thanks",
  "movies, music, sports and celebrities",
  "food, travel and weekend plans",
  "jokes, memes and complaints",
  "a link with no text",
];
/** Texts sent to the model in one call (the item text is cut to keep calls small). */
const BATCH = 40;
const ITEM_CHARS = 500;

export type TopicMatch = "own" | "words" | "meaning" | "both" | "none";
export type PassionTopic = { name: string; topics: string[]; handles: string[]; relation: "follow" | "involved" | "ours" };

/** The words that mark an item as being about the passion: its name, its topics and its X accounts. */
export function topicTerms(p: Pick<PassionTopic, "name" | "topics" | "handles">): string[] {
  const terms = [p.name, ...p.topics, ...p.handles, ...p.handles.map((h) => `@${h}`)].map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2);
  return [...new Set(terms)];
}

/** It mentions the passion's whole name, any topic or any of its accounts; or, for a name of several words, all of its main words. */
export function matchesWords(text: string, p: Pick<PassionTopic, "name" | "topics" | "handles">): boolean {
  if (topicTerms(p).some((t) => mentionsTerm(text, t))) return true;
  const main = p.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !["and", "the", "for", "ecosystem", "community", "news"].includes(w));
  return main.length > 0 && main.every((w) => mentionsTerm(text, w));
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    x += a[i]! * a[i]!;
    y += b[i]! * b[i]!;
  }
  return x && y ? dot / Math.sqrt(x * y) : 0;
};

/** For each text, how much closer it is to the passion than to small talk. Null for all when the model fails. */
export async function meaningMargins(texts: string[], p: Pick<PassionTopic, "name" | "topics">, embed: Embedder): Promise<(number | null)[]> {
  if (!texts.length) return [];
  const query = [p.name, ...p.topics].join(", ");
  const out: (number | null)[] = [];
  try {
    for (let i = 0; i < texts.length; i += BATCH) {
      const part = texts.slice(i, i + BATCH);
      const vectors = await embed([query, ...SMALL_TALK, ...part]);
      if (vectors.length !== 1 + SMALL_TALK.length + part.length) throw new Error("embedding count mismatch");
      const [q, ...rest] = vectors;
      const anchors = rest.slice(0, SMALL_TALK.length);
      for (const v of rest.slice(SMALL_TALK.length)) out.push(cosine(q!, v) - Math.max(...anchors.map((a) => cosine(a, v))));
    }
    return out;
  } catch (error) {
    console.warn("relevance: meaning check unavailable", error instanceof Error ? error.message : error);
    return texts.map(() => null);
  }
}

/** Whether the source belongs to the passion itself, so everything from it is on-topic. */
export function ownSource(p: Pick<PassionTopic, "relation" | "handles">, src: { kind: string; key: string }): boolean {
  if (p.relation === "ours") return true;
  if (src.kind === "github_repo") return true;
  return src.kind === "x_account" && p.handles.some((h) => h.toLowerCase() === src.key.toLowerCase());
}

/**
 * Judges a batch of a passion's new items: both checks at once, either is enough. The words are checked
 * on the whole text; the model sees it cut short. Returns one verdict per item, in order.
 */
export async function judgeRelevance(
  p: PassionTopic,
  src: { kind: string; key: string },
  items: { title: string; body?: string | undefined }[],
  embed: Embedder | undefined,
): Promise<{ match: TopicMatch; margin: number | null }[]> {
  if (!items.length) return [];
  if (ownSource(p, src)) return items.map(() => ({ match: "own", margin: null }));
  const texts = items.map((i) => `${i.title}\n${i.body ?? ""}`.trim());
  const [words, margins] = await Promise.all([
    Promise.resolve(texts.map((t) => matchesWords(t, p))),
    embed ? meaningMargins(texts.map((t) => t.slice(0, ITEM_CHARS)), p, embed) : Promise.resolve(texts.map(() => null)),
  ]);
  return texts.map((_, k) => {
    const byWords = words[k]!;
    const margin = margins[k] ?? null;
    const byMeaning = margin !== null && margin >= MEANING_MARGIN_MIN;
    return { match: byWords && byMeaning ? "both" : byWords ? "words" : byMeaning ? "meaning" : "none", margin };
  });
}

/** Rough Workers AI cost of one batch (bge-m3: about $0.012 per million input tokens; 4 characters a token). */
export function estimateRelevanceCost(texts: string[]): number {
  const chars = texts.reduce((n, t) => n + Math.min(t.length, ITEM_CHARS), 0) + SMALL_TALK.join(" ").length * Math.ceil(texts.length / BATCH);
  return Math.max(1, Math.ceil((chars / 4) * 0.012));
}
