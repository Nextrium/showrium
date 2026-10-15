import { describe, expect, it } from "vitest";
import { extractArticleLinks, ingestWatchedPage, resolveBlogSource } from "@nextrium/core";

const html = (body: string) => new Response(`<!doctype html><html><head><title>Blog</title></head><body>${body}</body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
const rss = (items: string) => new Response(`<?xml version="1.0"?><rss><channel><title>t</title>${items}</channel></rss>`, { headers: { "Content-Type": "application/rss+xml" } });
const item = (t: string) => `<item><title>${t}</title><link>https://ex.org/blog/${t}</link><description>About ${t}</description></item>`;
const listing = (slugs: string[]) =>
  html(`<nav><a href="/">Home</a><a href="/blog">Blog</a><a href="/blog/tag/ai">AI</a><a href="/blog/page/2">Next</a></nav>
    ${slugs.map((s) => `<article><a href="/blog/${s}">${s}</a><a href="/blog/${s}#comments">c</a></article>`).join("")}
    <a href="https://other.site/blog/x">elsewhere</a><a href="/about">About</a><a href="/blog/cover.png">img</a>`);
const article = (title: string) => new Response(`<!doctype html><html><head><title>${title} | Ex Blog</title></head><body><article><h1>${title}</h1><p>${"This is a long enough paragraph about the topic. ".repeat(4)}</p></article></body></html>`, { headers: { "Content-Type": "text/html" } });

/** A tiny fake web: exact URL → response factory. Anything else is a 404. */
const web = (routes: Record<string, () => Response>) => async (url: string) => routes[url]?.() ?? new Response("nope", { status: 404, headers: { "Content-Type": "text/html" } });

describe("resolving a blog address", () => {
  it("uses a feed address as it is", async () => {
    const out = await resolveBlogSource("https://ex.org/feed.xml", web({ "https://ex.org/feed.xml": () => rss(item("a")) }));
    expect(out).toEqual({ kind: "rss", key: "https://ex.org/feed.xml", how: "feed" });
  });
  it("follows the feed a page advertises", async () => {
    const f = web({
      "https://ex.org/blog": () => html(`<link rel="alternate" type="application/rss+xml" href="/blog/index.rss"><a href="/blog/a">a</a>`),
      "https://ex.org/blog/index.rss": () => rss(item("a")),
    });
    expect(await resolveBlogSource("https://ex.org/blog", f)).toEqual({ kind: "rss", key: "https://ex.org/blog/index.rss", how: "discovered" });
  });
  it("tries common feed paths", async () => {
    const f = web({ "https://ex.org/blog": () => listing(["a"]), "https://ex.org/blog/feed": () => rss(item("a")) });
    expect(await resolveBlogSource("https://ex.org/blog", f)).toEqual({ kind: "rss", key: "https://ex.org/blog/feed", how: "guessed" });
  });
  it("watches the page when there's no feed (like nextrium.org/blog)", async () => {
    const f = web({ "https://ex.org/blog": () => listing(["new-post", "older-post"]) });
    expect(await resolveBlogSource("https://ex.org/blog", f)).toEqual({ kind: "page", key: "https://ex.org/blog", how: "page" });
  });
  it("explains when there's nothing to follow", async () => {
    const f = web({ "https://ex.org/blog": () => html(`<p>Coming soon</p>`) });
    await expect(resolveBlogSource("https://ex.org/blog", f)).rejects.toThrow(/couldn't find a feed or any article links/);
  });
  it("refuses private addresses before fetching", async () => {
    await expect(resolveBlogSource("http://127.0.0.1/blog", web({}))).rejects.toThrow();
  });
});

describe("watching a page", () => {
  it("keeps only same-site article links under the page, in order, without tags, paging or files", () => {
    const text = `<a href="/blog/b">b</a><a href="/blog/a/">a</a><a href="/blog/b#x">dup</a><a href="/blog/tag/x">t</a><a href="/blog/page/2">p</a><a href="https://evil.example/blog/z">z</a><a href="/blog/pic.jpg">i</a><a href="/blog">self</a>`;
    expect(extractArticleLinks(text, "https://ex.org/blog")).toEqual(["https://ex.org/blog/b", "https://ex.org/blog/a"]);
  });

  it("first check reads the newest 3 and remembers the rest; later checks read only new ones", async () => {
    const slugs = ["p5", "p4", "p3", "p2", "p1"];
    const routes: Record<string, () => Response> = { "https://ex.org/blog": () => listing(slugs) };
    for (const s of ["p6", ...slugs]) routes[`https://ex.org/blog/${s}`] = () => article(`Post ${s}`);
    const first = await ingestWatchedPage("https://ex.org/blog", [], { fetch: web(routes) });
    expect(first.items.map((i) => i.externalId)).toEqual(["page:https://ex.org/blog/p5", "page:https://ex.org/blog/p4", "page:https://ex.org/blog/p3"]);
    expect(first.items[0]!.title).toBe("Post p5"); // site suffix removed
    expect(first.seen).toHaveLength(5);

    const again = await ingestWatchedPage("https://ex.org/blog", first.seen, { fetch: web(routes) });
    expect(again.items).toHaveLength(0); // p2 and p1 were remembered, not read

    slugs.unshift("p6");
    const later = await ingestWatchedPage("https://ex.org/blog", again.seen, { fetch: web(routes) });
    expect(later.items.map((i) => i.url)).toEqual(["https://ex.org/blog/p6"]);
  });
});
