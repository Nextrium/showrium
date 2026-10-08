// Platform rules as data (verified 2026-09-26; see internal-docs platform-policies.md).
// Changing a limit is a data change here, reviewed in a PR. Re-check quarterly.
import type { Platform } from "@nextrium/db";

export interface PlatformRule {
  label: string;
  /** Hard length limit, counted as the platform counts it (see `countFor`). */
  maxLength: number;
  countMethod: "x_weighted" | "graphemes" | "chars";
  maxHashtags: number;
  /** Links in the text: "ok", "warn" (e.g. X charges $0.20 per API post with a URL), or "strip". */
  links: "ok" | "warn";
  /** The post needs media to publish (Instagram, TikTok, YouTube). */
  requiresMedia: "none" | "image" | "video";
  /** How Showrium publishes today, before app reviews complete. */
  publishPath: "api" | "tap_to_post" | "draft_inbox";
  /** Label AI-generated realistic media on this platform. */
  aiLabel: string;
}

export const PLATFORM_RULES: Record<Platform, PlatformRule> = {
  linkedin: { label: "LinkedIn", maxLength: 3000, countMethod: "chars", maxHashtags: 5, links: "ok", requiresMedia: "none", publishPath: "api", aiLabel: "Disclose AI-generated realistic media in the post text." },
  x: { label: "X", maxLength: 280, countMethod: "x_weighted", maxHashtags: 2, links: "warn", requiresMedia: "none", publishPath: "tap_to_post", aiLabel: "Disclose AI-generated realistic media." },
  instagram: { label: "Instagram", maxLength: 2200, countMethod: "chars", maxHashtags: 5, links: "warn", requiresMedia: "image", publishPath: "tap_to_post", aiLabel: "Meta applies \"AI info\" from C2PA metadata." },
  facebook: { label: "Facebook", maxLength: 63206, countMethod: "chars", maxHashtags: 3, links: "ok", requiresMedia: "none", publishPath: "tap_to_post", aiLabel: "Meta applies \"AI info\" from C2PA metadata." },
  threads: { label: "Threads", maxLength: 500, countMethod: "graphemes", maxHashtags: 1, links: "ok", requiresMedia: "none", publishPath: "tap_to_post", aiLabel: "Meta applies \"AI info\" from C2PA metadata." },
  bluesky: { label: "Bluesky", maxLength: 300, countMethod: "graphemes", maxHashtags: 3, links: "ok", requiresMedia: "none", publishPath: "api", aiLabel: "Self-label AI content." },
  mastodon: { label: "Mastodon", maxLength: 500, countMethod: "chars", maxHashtags: 5, links: "ok", requiresMedia: "none", publishPath: "api", aiLabel: "Use a content warning or note for AI media." },
  tiktok: { label: "TikTok", maxLength: 2200, countMethod: "chars", maxHashtags: 5, links: "warn", requiresMedia: "video", publishPath: "draft_inbox", aiLabel: "Set the AIGC label on realistic AI content." },
  youtube_shorts: { label: "YouTube Shorts", maxLength: 5000, countMethod: "chars", maxHashtags: 3, links: "ok", requiresMedia: "video", publishPath: "draft_inbox", aiLabel: "Set containsSyntheticMedia for realistic AI content." },
};

/** Platforms where a post can be a thread (a chain of replies to itself). */
export const THREAD_PLATFORMS: Platform[] = ["x", "bluesky", "threads", "mastodon"];
export const MAX_THREAD_PARTS = 20;
/** X Premium (any tier with long posts) raises the X limit to 25,000 characters. */
export const X_LONG_MAX = 25_000;
/** X subscription types (from users/me) that include long posts. */
export const X_LONG_SUBSCRIPTIONS = ["Basic", "Premium", "PremiumPlus"];
