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

/** Latest published releases of a public GitHub repository. */
export async function ingestGithubReleases(repo: string, opts: { fetch?: FetchLike | undefined; token?: string | undefined } = {}): Promise<IngestedItem[]> {
  if (!GITHUB_REPO_RE.test(repo)) throw new Error("Use the form owner/repository.");
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`https://api.github.com/repos/${repo}/releases?per_page=5`, {
    headers: {
      "User-Agent": "Showrium",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) throw new Error("Repository not found, or it's private.");
  if (res.status === 403 || res.status === 429) throw new Error("GitHub's rate limit was reached. Try again later.");
  if (!res.ok) throw new Error(`GitHub answered with HTTP ${res.status}.`);
  const releases = (await res.json()) as { id: number; name: string | null; tag_name: string; body: string | null; html_url: string; draft: boolean }[];
  return releases
    .filter((r) => !r.draft)
    .map((r) => ({
      externalId: `gh:${repo}:${r.id}`,
      title: `${repo} ${r.name || r.tag_name}`.slice(0, 300),
      body: clip(`Release ${r.tag_name} of ${repo}.\n\n${r.body ?? ""}`.trim()),
      url: r.html_url,
    }));
}
