// Turning outside material into context items: web pages, RSS/Atom feeds, GitHub releases.
import { safeFetchText } from "./safe-fetch.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export const MAX_CONTEXT_CHARS = 20_000;

export interface IngestedItem {
  externalId: string | null;
  title: string;
  body: string;
  url: string | null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
}

export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}

const clip = (s: string) => (s.length > MAX_CONTEXT_CHARS ? `${s.slice(0, MAX_CONTEXT_CHARS)}…` : s);

/** Reads a public web page into a title and plain text. */
export async function ingestUrl(raw: string, doFetch?: FetchLike): Promise<IngestedItem> {
  const page = await safeFetchText(raw, { fetch: doFetch, allowedTypes: /text\/html|application\/xhtml|text\/plain/ });
  if (page.contentType.includes("text/plain")) return { externalId: null, title: "", body: clip(page.text.trim()), url: page.url };
  const title = decodeEntities(page.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "");
  const description = decodeEntities(page.text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ?? "");
  const main = page.text.match(/<(article|main)[\s\S]*?<\/\1>/i)?.[0] ?? page.text.match(/<body[\s\S]*<\/body>/i)?.[0] ?? page.text;
  const text = stripTags(main);
  const body = clip([description, text].filter(Boolean).join("\n\n"));
  if (body.length < 40) throw new Error("Couldn't find readable text on that page.");
  return { externalId: null, title: title.slice(0, 300), body, url: page.url };
}

/** Parses RSS 2.0 and Atom. Tolerant: skips entries it can't read. */
export function parseFeed(xml: string): IngestedItem[] {
  const pick = (block: string, tag: string) => {
    const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
    if (!m) return "";
    return m[1]!.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1").trim();
  };
  const items: IngestedItem[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const block of blocks.slice(0, 20)) {
    const atomLink = block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ?? null;
    const rawLink = decodeEntities(pick(block, "link") || atomLink || "").trim();
    // Feeds are outside input: keep only web links (never javascript: or data: URLs).
    const link = /^https?:\/\//i.test(rawLink) ? rawLink.slice(0, 2000) : null;
    const title = stripTags(pick(block, "title"));
    const body = stripTags(pick(block, "content:encoded") || pick(block, "description") || pick(block, "content") || pick(block, "summary"));
    const guid = pick(block, "guid") || pick(block, "id") || link || title;
    if (!title && !body) continue;
    items.push({ externalId: guid ? `rss:${guid.slice(0, 300)}` : null, title: title.slice(0, 300), body: clip(body || title), url: link || null });
  }
  return items;
}

export async function ingestFeed(url: string, doFetch?: FetchLike): Promise<IngestedItem[]> {
  const feed = await safeFetchText(url, { fetch: doFetch, accept: "application/rss+xml,application/atom+xml,application/xml,text/xml", allowedTypes: /xml|rss|atom|text\/plain/ });
  return parseFeed(feed.text);
}

export const GITHUB_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

// --- GitHub: public feeds (no API token, no API rate limit) ---------------------------------------

interface AtomEntry {
  id: string;
  title: string;
  link: string | null;
  updated: string;
  content: string;
}

function parseAtom(xml: string): AtomEntry[] {
  const tag = (block: string, name: string) => decodeEntities(block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"))?.[1]?.trim() ?? "");
  return (xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? []).slice(0, 40).map((block) => ({
    id: tag(block, "id"),
    title: stripTags(tag(block, "title")),
    link: block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ?? null,
    updated: tag(block, "updated"),
    content: stripTags(tag(block, "content")),
  }));
}

export class GithubSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubSourceError";
  }
}

async function githubFeed(path: string, doFetch?: FetchLike) {
  try {
    const page = await safeFetchText(`https://github.com/${path}`, { fetch: doFetch, accept: "application/atom+xml", allowedTypes: /xml|atom/, maxBytes: 2_000_000 });
    return parseAtom(page.text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/404/.test(message)) throw new GithubSourceError("We couldn't read this repository. Check the name, and that it's public.");
    if (/429|403/.test(message)) throw new GithubSourceError("GitHub asked us to slow down. We'll check again automatically.");
    throw new GithubSourceError("GitHub didn't respond. We'll check again automatically.");
  }
}

/**
 * What happened in a public repository: each release, plus one item per finished day of commits
 * (so people who never publish releases still get ideas). Today's commits are gathered once the day
 * is over (UTC), so a day's work is one post-worthy moment rather than many small ones.
 */
export async function ingestGithubActivity(repo: string, opts: { fetch?: FetchLike | undefined; now?: Date } = {}) {
  if (!GITHUB_REPO_RE.test(repo)) throw new GithubSourceError("Use the form owner/repository.");
  const [releases, commits] = await Promise.all([githubFeed(`${repo}/releases.atom`, opts.fetch), githubFeed(`${repo}/commits.atom`, opts.fetch)]);
  const releaseItems: IngestedItem[] = releases.slice(0, 5).map((r) => {
    const tagName = r.link?.split("/").pop() ?? r.title;
    return { externalId: `gh-release:${repo}:${tagName}`.slice(0, 300), title: `${repo} ${r.title}`.slice(0, 300), body: clip(`Release ${r.title} of ${repo}.\n\n${r.content}`.trim()), url: r.link };
  });

  const today = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const byDay = new Map<string, AtomEntry[]>();
  for (const c of commits) {
    const day = c.updated.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= today) continue;
    byDay.set(day, [...(byDay.get(day) ?? []), c]);
  }
  const activityItems: IngestedItem[] = [...byDay.entries()].slice(0, 7).map(([day, list]) => {
    const merged = list.filter((c) => /^Merge pull request/i.test(c.title)).length;
    const summary = `${list.length} commit${list.length === 1 ? "" : "s"}${merged ? `, ${merged} merged pull request${merged === 1 ? "" : "s"}` : ""}`;
    return {
      externalId: `gh-day:${repo}:${day}`,
      title: `${summary} on ${repo} (${day})`,
      body: clip(
        `Work on ${repo} on ${day}: ${summary}.\n\n${list
          .map((c) => {
            // The feed's content repeats the commit title before the details.
            const details = (c.content.startsWith(c.title) ? c.content.slice(c.title.length) : c.content).trim();
            return `- ${c.title}${details ? `: ${details.replace(/\s+/g, " ").slice(0, 300)}` : ""}`;
          })
          .join("\n")}`,
      ),
      url: `https://github.com/${repo}/commits`,
    };
  });
  return { releases: releaseItems, activity: activityItems };
}
