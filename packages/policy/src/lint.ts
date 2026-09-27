// Lints a post for one platform. Errors block publishing; warnings are shown to the user.
import type { Platform } from "@nextrium/db";
import { PLATFORM_RULES } from "./rules.js";

export interface LintIssue {
  code: "too_long" | "empty" | "too_many_hashtags" | "has_link" | "needs_media" | "placeholder" | "control_chars" | "unverified_fact";
  severity: "error" | "warn";
  message: string;
}

const URL_RE = /\bhttps?:\/\/[^\s)]+/gi;
const HASHTAG_RE = /(^|\s)#[\p{L}\p{N}_]+/gu;
// Leftover template markers a model sometimes emits instead of real content.
const PLACEHOLDER_RE = /\[(?:insert|your|link|name|company)[^\]]*\]|\{\{[^}]+\}\}|lorem ipsum/i;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function graphemeCount(text: string): number {
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

/**
 * X's weighted length (approximation of twitter-text v3): URLs count 23, characters in
 * Latin-1 and common punctuation ranges count 1, everything else (CJK, emoji) counts 2.
 */
export function xWeightedLength(text: string): number {
  let length = 0;
  const withoutUrls = text.replace(URL_RE, () => {
    length += 23;
    return "";
  });
  for (const g of segmenter.segment(withoutUrls)) {
    const cp = g.segment.codePointAt(0) ?? 0;
    const light = cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);
    length += light && g.segment.length === 1 ? 1 : 2;
  }
  return length;
}

export function countFor(platform: Platform, text: string): number {
  const method = PLATFORM_RULES[platform].countMethod;
  return method === "x_weighted" ? xWeightedLength(text) : method === "graphemes" ? graphemeCount(text) : text.length;
}

export function lintPost(platform: Platform, text: string, opts: { hasMedia?: boolean } = {}): LintIssue[] {
  const rule = PLATFORM_RULES[platform];
  const issues: LintIssue[] = [];
  const trimmed = text.trim();
  if (!trimmed) return [{ code: "empty", severity: "error", message: "The post is empty." }];

  const length = countFor(platform, trimmed);
  if (length > rule.maxLength) {
    issues.push({ code: "too_long", severity: "error", message: `${rule.label} allows ${rule.maxLength} characters; this is ${length}.` });
  }
  const hashtags = trimmed.match(HASHTAG_RE)?.length ?? 0;
  if (hashtags > rule.maxHashtags) {
    issues.push({ code: "too_many_hashtags", severity: "warn", message: `${hashtags} hashtags; ${rule.label} posts do best with ${rule.maxHashtags} or fewer.` });
  }
  if (rule.links === "warn" && URL_RE.test(trimmed)) {
    issues.push({
      code: "has_link",
      severity: "warn",
      message: platform === "x" ? "Links on X cost 25 credits when auto-posted. Tap-to-post is free." : `Links aren't clickable in ${rule.label} captions.`,
    });
  }
  URL_RE.lastIndex = 0;
  if (rule.requiresMedia !== "none" && !opts.hasMedia) {
    issues.push({ code: "needs_media", severity: "warn", message: `${rule.label} needs ${rule.requiresMedia === "video" ? "a video" : "an image"} to publish.` });
  }
  if (PLACEHOLDER_RE.test(trimmed)) {
    issues.push({ code: "placeholder", severity: "error", message: "The post contains a placeholder like [insert link]. Replace it before publishing." });
  }
  if (CONTROL_RE.test(trimmed)) {
    issues.push({ code: "control_chars", severity: "error", message: "The post contains hidden control or direction-override characters." });
  }
  return issues;
}

export const hasErrors = (issues: LintIssue[]) => issues.some((i) => i.severity === "error");

export type FactIssue = LintIssue & { code: "unverified_fact" };

/**
 * Flags @handles, numbers and links in a draft that don't appear in the source material.
 * Models sometimes "correct" handles (@kemi-dev -> @kemi_dev) or invent figures; the user must check them.
 */
export function checkFacts(text: string, source: string): FactIssue[] {
  const src = source.toLowerCase();
  const found = new Set<string>();
  for (const m of text.matchAll(/@[a-z0-9][a-z0-9._-]*[a-z0-9]/gi)) found.add(m[0]);
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s)]+/gi)) found.add(m[0].replace(/[.,!?]+$/, ""));
  for (const m of text.matchAll(/(?<![\w.])\d+(?:[.,]\d+)*%?/g)) found.add(m[0]);
  const unverified = [...found].filter((token) => !src.includes(token.toLowerCase()));
  return unverified.length
    ? [{ code: "unverified_fact", severity: "warn", message: `Check these against your source: ${unverified.slice(0, 5).join(", ")}.` }]
    : [];
}
