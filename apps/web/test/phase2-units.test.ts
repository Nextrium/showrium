import { describe, expect, it } from "vitest";
import { checkFacts, lintPost, xWeightedLength, graphemeCount } from "@nextrium/policy";
import { assertSafeUrl, can, decodeEntities, ingestGithubActivity, parseFeed, stripTags, UnsafeUrlError } from "@nextrium/core";
import { AllProvidersFailedError, checkVariants, extractJson, fakeProvider, generateStructured, type Provider } from "@nextrium/llm";
import { z } from "zod";

describe("platform linter", () => {
  it("counts X length the way X does (URLs = 23, emoji and CJK = 2)", () => {
    expect(xWeightedLength("hello")).toBe(5);
    expect(xWeightedLength("see https://example.com/a/very/long/path")).toBe(4 + 23);
    expect(xWeightedLength("日本")).toBe(4);
    expect(xWeightedLength("👍🏽")).toBe(2);
  });
  it("counts graphemes for Bluesky and Threads", () => {
    expect(graphemeCount("👨‍👩‍👧‍👦 hi")).toBe(4);
  });
  it("flags posts over the limit as errors", () => {
    expect(lintPost("x", "a".repeat(281)).some((i) => i.code === "too_long" && i.severity === "error")).toBe(true);
    expect(lintPost("x", "a".repeat(280)).some((i) => i.code === "too_long")).toBe(false);
    expect(lintPost("bluesky", "é".repeat(301)).some((i) => i.code === "too_long")).toBe(true);
  });
  it("warns about links on X, hashtags over the limit and missing media", () => {
    expect(lintPost("x", "read https://a.io").map((i) => i.code)).toContain("has_link");
    expect(lintPost("x", "#a #b #c").map((i) => i.code)).toContain("too_many_hashtags");
    expect(lintPost("tiktok", "HOOK: hi").map((i) => i.code)).toContain("needs_media");
    expect(lintPost("linkedin", "read https://a.io").map((i) => i.code)).not.toContain("has_link");
  });
  it("blocks empty posts, placeholders and hidden direction-override characters", () => {
    expect(lintPost("linkedin", "   ")[0]?.code).toBe("empty");
    expect(lintPost("linkedin", "Read more at [insert link]").map((i) => i.code)).toContain("placeholder");
    expect(lintPost("linkedin", "safe‮txt.exe").map((i) => i.code)).toContain("control_chars");
  });
});

describe("fact check against the source", () => {
  const source = "Release v1.4.0: 38% lower p99 latency, dead-letter after 5 fails. Thanks @kemi-dev. https://github.com/a/b";
  it("passes handles, numbers and links that are in the source", () => {
    expect(checkFacts("v1.4.0 cut p99 by 38% after 5 fails, thanks @kemi-dev https://github.com/a/b.", source)).toEqual([]);
  });
  it("flags altered handles, invented numbers and new links", () => {
    const issues = checkFacts("Thanks @kemi_dev! Latency down 45%, see https://evil.example", source);
    expect(issues[0]?.message).toMatch(/@kemi_dev/);
    expect(issues[0]?.message).toMatch(/45%/);
    expect(issues[0]?.message).toMatch(/evil/);
  });
});

describe("SSRF protection for user links", () => {
  it.each([
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://[::1]/",
    "http://localhost/",
    "http://metadata.google.internal/",
    "https://printer.local/",
    "https://example.com:8080/",
    "ftp://example.com/",
    "https://user:pass@example.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
    "http://intranet/",
  ])("rejects %s", (url) => {
    expect(() => assertSafeUrl(url)).toThrow(UnsafeUrlError);
  });
  it("accepts ordinary public sites", () => {
    expect(assertSafeUrl("https://blog.example.com/post?id=1").hostname).toBe("blog.example.com");
  });
});

describe("feed and page parsing", () => {
  it("reads RSS with CDATA and Atom entries", () => {
    const rss = `<rss><channel><item><title><![CDATA[Hello & welcome]]></title><link>https://x.io/1</link><guid>g1</guid><description>&lt;p&gt;Body&lt;/p&gt;</description></item></channel></rss>`;
    const atom = `<feed><entry><title>Atom post</title><link href="https://y.io/2"/><id>tag:y,1</id><summary>Short</summary></entry></feed>`;
    expect(parseFeed(rss)[0]).toMatchObject({ title: "Hello & welcome", url: "https://x.io/1", externalId: "rss:g1" });
    expect(parseFeed(atom)[0]).toMatchObject({ title: "Atom post", url: "https://y.io/2", body: "Short" });
    expect(parseFeed("<html>not a feed</html>")).toEqual([]);
  });
  it("strips scripts and decodes entities", () => {
    expect(stripTags("<p>Hi</p><script>alert(1)</script><style>x{}</style>&amp;")).toBe("Hi\n&");
    expect(decodeEntities("&#x1F600;&#65;&unknown;")).toBe("😀A&unknown;");
  });
  it("reads public GitHub activity from feeds: releases, and commits grouped by finished day", async () => {
    const atom = (entries: string) => new Response(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`, { headers: { "Content-Type": "application/atom+xml" } });
    const feeds = async (url: string) =>
      url.endsWith("/releases.atom")
        ? atom(`<entry><id>tag:github.com,2008:Repository/1/v1.0.0</id><updated>2026-09-20T10:00:00Z</updated><link rel="alternate" href="https://github.com/a/b/releases/tag/v1.0.0"/><title>v1.0.0</title><content type="html">&lt;p&gt;Notes&lt;/p&gt;</content></entry>`)
        : atom(`
          <entry><id>c1</id><updated>2026-09-27T09:00:00Z</updated><title>Today’s work in progress</title></entry>
          <entry><id>c2</id><updated>2026-09-26T18:00:00Z</updated><title>Merge pull request #12 from a/teams</title></entry>
          <entry><id>c3</id><updated>2026-09-26T11:00:00Z</updated><title>Add team invites</title></entry>
          <entry><id>c4</id><updated>2026-09-25T11:00:00Z</updated><title>Fix typo</title></entry>`);
    const out = await ingestGithubActivity("a/b", { fetch: feeds, now: new Date("2026-09-27T12:00:00Z") });
    expect(out.releases.map((r) => r.externalId)).toEqual(["gh-release:a/b:v1.0.0"]);
    expect(out.releases[0]!.body).toContain("Notes");
    // Today is left for later; each finished day becomes one item.
    expect(out.activity.map((a) => a.externalId)).toEqual(["gh-day:a/b:2026-09-26", "gh-day:a/b:2026-09-25"]);
    expect(out.activity[0]!.title).toBe("2 commits, 1 merged pull request on a/b (2026-09-26)");
    await expect(ingestGithubActivity("a/b", { fetch: async () => new Response("", { status: 404 }) })).rejects.toThrow(/public/);
    await expect(ingestGithubActivity("a/b", { fetch: async () => new Response("", { status: 429 }) })).rejects.toThrow(/slow down/);
    await expect(ingestGithubActivity("../etc", { fetch: feeds })).rejects.toThrow(/owner\/repository/);
  });
});

describe("AI provider chain", () => {
  const schema = z.object({ ok: z.boolean() });
  const failing = (name: string, error: Error): Provider => ({ name, price: { input: 0, output: 0 }, generate: async () => { throw error; } });

  it("falls through errors and invalid output to the first valid answer", async () => {
    const out = await generateStructured(
      [failing("down", new Error("HTTP 500")), fakeProvider(() => "not json", "garbled"), fakeProvider(() => '```json\n{"ok": true}\n```', "good")],
      { system: "s", user: "u", maxTokens: 10 },
      schema,
    );
    expect(out.model).toBe("good");
    expect(out.attempts.map((a) => a.model)).toEqual(["down", "garbled"]);
  });
  it("uses the custom validator to reject incomplete answers", async () => {
    await expect(generateStructured([fakeProvider(() => '{"ok": false}')], { system: "", user: "", maxTokens: 1 }, schema, (d) => (d.ok ? null : "not ok"))).rejects.toBeInstanceOf(
      AllProvidersFailedError,
    );
  });
  it("extracts JSON wrapped in prose", () => {
    expect(extractJson('Sure! {"a": 1} Hope that helps')).toEqual({ a: 1 });
    expect(() => extractJson("no json here")).toThrow();
  });
  it("requires exactly one variant per requested platform", () => {
    const base = { angle: "a", key_points: ["k"] };
    expect(checkVariants({ ...base, variants: [{ platform: "x", text: "t" }] }, ["x", "linkedin"])).toMatch(/missing/);
    expect(checkVariants({ ...base, variants: [{ platform: "x", text: "t" }, { platform: "x", text: "u" }] }, ["x"])).toMatch(/duplicate/);
    expect(checkVariants({ ...base, variants: [{ platform: "x", text: "t" }] }, ["x"])).toBeNull();
  });
});

describe("role permissions", () => {
  it.each([
    ["owner", ["content.read", "content.write", "draft.approve", "publish", "workspace.manage"]],
    ["admin", ["content.read", "content.write", "draft.approve", "publish", "workspace.manage"]],
    ["editor", ["content.read", "content.write"]],
    ["approver", ["content.read", "draft.approve", "publish"]],
    ["viewer", ["content.read"]],
    ["mystery", []],
  ] as const)("%s", (role, allowed) => {
    for (const p of ["content.read", "content.write", "draft.approve", "publish", "workspace.manage"] as const) {
      expect(can(role, p)).toBe((allowed as readonly string[]).includes(p));
    }
  });
});
