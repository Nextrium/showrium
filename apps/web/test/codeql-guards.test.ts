import { describe, expect, it } from "vitest";
import { mastodonEngagement } from "@nextrium/platforms";
import { apiPath } from "../src/api-path";

// The two older CodeQL findings (2026-10-21): requests built from the page address stay on
// Showrium's own API, and HTML from other servers can never leave a tag behind.

describe("the app's API paths", () => {
  it("allows normal paths, encoded ids and query strings", () => {
    expect(apiPath("/drafts/drf_123")).toBe("/api/v1/drafts/drf_123");
    expect(apiPath(`/ideas/${encodeURIComponent("idea x/y")}`)).toBe("/api/v1/ideas/idea%20x%2Fy");
    expect(apiPath("/drafts?status=draft&needsYou=true")).toBe("/api/v1/drafts?status=draft&needsYou=true");
  });

  it("refuses anything that could leave /api/v1 or reach another host", () => {
    for (const bad of ["drafts", "//evil.example/x", "/../auth/sign-out", "/drafts/..%2F..", "/a/../b", "/x\\y", "/javascript:alert(1)", "/https://evil.example", "/a\nb"]) {
      expect(() => apiPath(bad), bad).toThrow("That link isn't valid.");
    }
  });
});

describe("replies from other servers become plain text", () => {
  const status = (content: string) => ({ id: "1", account: { acct: "a" }, content });
  const fakeMastodon = (contents: string[]) =>
    (async (url: string) =>
      url.includes("/context")
        ? Response.json({ descendants: contents.map((c, i) => ({ ...status(c), id: String(i + 2), in_reply_to_id: "1" })) })
        : Response.json({ favourites_count: 0, replies_count: contents.length, reblogs_count: 0 })) as typeof fetch;

  it("removes every tag, nested or broken, and decodes entities last", async () => {
    const out = await mastodonEngagement("mastodon.example", "1", fakeMastodon([
      "<p>Hello <b>there</b></p>",
      "<scr<script>ipt>alert(1)</scr</script>ipt>",
      "a <img src=x onerror=alert(1)> b",
      "unclosed <a href='x' tail",
      "&amp;lt;b&amp;gt; stays text",
    ]));
    const texts = out.comments.map((c) => c.text).reverse(); // the reader lists newest first
    expect(texts[0]).toBe("Hello there");
    for (const t of texts.slice(1, 4)) expect(t).not.toMatch(/<[a-z/]/i);
    expect(texts[2]).toBe("a  b");
    expect(texts[4]).toBe("&lt;b&gt; stays text");
  });
});
