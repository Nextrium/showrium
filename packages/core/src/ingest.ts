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

// --- Any blog or site: find its feed, or watch the page itself -------------------------------------

const FEED_TYPES = /xml|rss|atom/;
const COMMON_FEED_PATHS = ["feed", "rss.xml", "feed.xml", "atom.xml", "index.xml"];

export type ResolvedSource = { kind: "rss" | "page"; key: string; how: "feed" | "discovered" | "guessed" | "page" };

/**
 * People paste whatever address they have (usually the blog page, not its feed). Resolve it:
 * a feed is used as is; a page's advertised feed is used next; then a few common feed paths;
 * otherwise the page itself is watched for new article links.
 */
export async function resolveBlogSource(raw: string, doFetch?: FetchLike): Promise<ResolvedSource> {
  // Big server-rendered pages can be slow to finish streaming; give the page itself more time.
  const page = await safeFetchText(raw, { fetch: doFetch, timeoutMs: 15_000, maxBytes: 2_000_000 });
  if (FEED_TYPES.test(page.contentType) && parseFeed(page.text).length) return { kind: "rss", key: page.url, how: "feed" };
  if (!/html/.test(page.contentType)) throw new Error("That address isn't a web page or a feed.");
  const advertised = [...page.text.matchAll(/<link\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((tag) => /rel=["']?alternate/i.test(tag) && /type=["']?application\/(rss|atom)\+xml/i.test(tag))
    .map((tag) => tag.match(/href=["']([^"']+)["']/i)?.[1])
    .filter((h): h is string => Boolean(h));
  for (const href of advertised.slice(0, 2)) {
    const url = new URL(decodeEntities(href), page.url).toString();
    if (await looksLikeFeed(url, doFetch)) return { kind: "rss", key: url, how: "discovered" };
  }
  const base = new URL(page.url);
  const dir = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const guesses = [...new Set([...COMMON_FEED_PATHS.map((p) => new URL(`${dir}${p}`, base).toString()), new URL("/feed", base).toString(), new URL("/rss.xml", base).toString()])].slice(0, 5);
  // Tried together (most answer 404 quickly); the first match in this order wins.
  const hits = await Promise.all(guesses.map((url) => looksLikeFeed(url, doFetch)));
  const guessed = guesses[hits.indexOf(true)];
  if (guessed) return { kind: "rss", key: guessed, how: "guessed" };
  if (!extractArticleLinks(page.text, page.url).length) throw new Error("We couldn't find a feed or any article links on that page. Try the page that lists your posts.");
  return { kind: "page", key: page.url, how: "page" };
}

async function looksLikeFeed(url: string, doFetch?: FetchLike) {
  try {
    const res = await safeFetchText(url, { fetch: doFetch, accept: "application/rss+xml,application/atom+xml,application/xml,text/xml", allowedTypes: FEED_TYPES, timeoutMs: 6_000 });
    return parseFeed(res.text).length > 0;
  } catch {
    return false;
  }
}

const NOT_ARTICLES = /\/(tag|tags|category|categories|author|authors|page|search|feed|rss)(\/|$)/i;

/**
 * Article links on a listing page: same site, below the page's own path (a /blog page lists
 * /blog/<post>), in page order (usually newest first), without tag, category or paging links.
 */
export function extractArticleLinks(html: string, pageUrl: string): string[] {
  const page = new URL(pageUrl);
  const prefix = page.pathname.replace(/\/$/, "");
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)) {
    let url: URL;
    try {
      url = new URL(decodeEntities(m[1]!), page);
    } catch {
      continue;
    }
    if (url.host !== page.host || !/^https?:$/.test(url.protocol)) continue;
    const path = url.pathname.replace(/\/$/, "");
    if (!path.startsWith(`${prefix}/`) || path === prefix || NOT_ARTICLES.test(path) || /\.(xml|jpe?g|png|gif|webp|svg|pdf|zip)$/i.test(path)) continue;
    const clean = `${url.origin}${path}`;
    if (!out.includes(clean)) out.push(clean);
    if (out.length >= 60) break;
  }
  return out;
}

/**
 * A watched page: new article links since last time, each read as an item. On the first check
 * only the newest few are read and everything else is remembered, so old posts don't flood ideas.
 */
export async function ingestWatchedPage(pageUrl: string, seen: string[], opts: { fetch?: FetchLike | undefined; perCheck?: number } = {}) {
  const page = await safeFetchText(pageUrl, { fetch: opts.fetch, allowedTypes: /html/, timeoutMs: 15_000, maxBytes: 2_000_000 });
  const links = extractArticleLinks(page.text, page.url);
  const fresh = links.filter((l) => !seen.includes(l)).slice(0, opts.perCheck ?? 3);
  const items: IngestedItem[] = [];
  for (const link of fresh) {
    try {
      const article = await ingestUrl(link, opts.fetch);
      // "Post title | Site name" → "Post title" (short trailing site names only).
      const title = article.title.replace(/\s+[|–—-]\s+[^|–—-]{1,40}$/, "").trim() || article.title;
      items.push({ ...article, title, externalId: `page:${link}`.slice(0, 300), url: link });
    } catch {
      // Unreadable article: skipped, and remembered so it isn't retried every check.
    }
  }
  // Remember everything on the page now (newest first, capped) plus anything seen before.
  const nextSeen = [...new Set([...links, ...seen])].slice(0, 300);
  return { items, seen: nextSeen };
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
