import { describe, expect, it } from "vitest";
import { parseFeed, stripTags } from "@nextrium/core";
import { extractJson } from "@nextrium/llm";
import { checkFacts, lintPost } from "@nextrium/policy";

// Hostile inputs that made the old regexes take quadratic time (CodeQL). Each must finish quickly.
const fast = (fn: () => unknown) => {
  const t = performance.now();
  fn();
  expect(performance.now() - t).toBeLessThan(500);
};

describe("parsers stay fast and correct on hostile text", () => {
  it("strips scripts and svgs, in linear time", () => {
    expect(stripTags("<p>Hi</p><script>alert(1)</script><SVG a='b'><path/></svg><p>there</p>")).toBe("Hi\nthere");
    fast(() => stripTags("<svg".repeat(50_000)));
    fast(() => stripTags("<script>".repeat(50_000)));
    fast(() => stripTags("<a ".repeat(50_000)));
  });

  it("reads feeds, in linear time", () => {
    const items = parseFeed(`<rss><channel><item><title><![CDATA[A > B]]></title><link>https://ex.org/1</link><description>Body text</description></item></channel></rss>`);
    expect(items[0]).toMatchObject({ title: "A > B", url: "https://ex.org/1" });
    fast(() => parseFeed("<item\t".repeat(50_000)));
    fast(() => parseFeed("<entry\t".repeat(50_000)));
    fast(() => parseFeed(`<entry>${"<link ".repeat(50_000)}</entry>`));
  });

  it("pulls JSON out of fenced or plain replies", () => {
    expect(extractJson('Sure:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"b":2}')).toEqual({ b: 2 });
    fast(() => expect(() => extractJson(`\`\`\`${" ".repeat(100_000)}`)).toThrow());
  });

  it("lint rules still catch placeholders and trim link punctuation", () => {
    expect(lintPost("bluesky", "Read it here [insert link]").some((i) => i.code === "placeholder")).toBe(true);
    expect(lintPost("bluesky", "Hello {{name}}, welcome").some((i) => i.code === "placeholder")).toBe(true);
    expect(checkFacts("See https://ex.org/a!!!", "https://ex.org/a")).toEqual([]);
    fast(() => lintPost("bluesky", `[your${"[link".repeat(20_000)}`));
    fast(() => lintPost("bluesky", "{{{{".repeat(20_000)));
    fast(() => checkFacts(`https://x${"!".repeat(50_000)}a`, ""));
  });
});
