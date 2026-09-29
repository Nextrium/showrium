// Showrium database schema (Cloudflare D1 / SQLite).
// Portability rules (ADR-0002): Drizzle only, text IDs, no SQLite-only SQL.
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" }).notNull().default(sql`(unixepoch() * 1000)`);
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" }).notNull().default(sql`(unixepoch() * 1000)`);

// ---------------------------------------------------------------------------
// Auth tables (shape required by Better Auth's Drizzle adapter)
// ---------------------------------------------------------------------------

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Tenancy: every business row belongs to an org. All queries filter by org_id.
// ---------------------------------------------------------------------------

export const org = sqliteTable("org", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: text("plan", { enum: ["free", "lite", "starter", "creator", "pro", "team"] }).notNull().default("free"),
  // Set on a user's personal workspace. Unique, so concurrent requests can't create two.
  // Deliberately no foreign key: SQLite can't add ON DELETE rules to an existing table, and a
  // plain reference would block deleting the user. Account deletion removes the personal org.
  personalOwnerUserId: text("personal_owner_user_id").unique(),
  /** Full access granted by a platform admin (staff, testers, partners). Overrides plan limits with the staff tier. */
  fullAccess: integer("full_access", { mode: "boolean" }).notNull().default(false),
  fullAccessNote: text("full_access_note"),
  fullAccessBy: text("full_access_by"),
  fullAccessAt: integer("full_access_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
});

export const ROLES = ["owner", "admin", "editor", "approver", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const membership = sqliteTable(
  "membership",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => org.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ROLES }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("membership_org_user_uq").on(t.orgId, t.userId), index("membership_user_idx").on(t.userId)],
);

// API keys: only a SHA-256 hash is stored. The plaintext is shown once at creation.
export const apiKey = sqliteTable(
  "api_key",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => org.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull().unique(),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("api_key_org_idx").on(t.orgId)],
);

// ---------------------------------------------------------------------------
// Credits: double-entry ledger. Each transaction has entries that sum to zero.
// An org's balance is the sum of its "org" account entries. 1 credit = $0.01.
// ---------------------------------------------------------------------------

export const CREDIT_TXN_KINDS = ["grant", "purchase", "spend", "refund", "adjustment"] as const;
export type CreditTxnKind = (typeof CREDIT_TXN_KINDS)[number];

export const creditTxn = sqliteTable(
  "credit_txn",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => org.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: CREDIT_TXN_KINDS }).notNull(),
    // Retries with the same key never apply twice.
    idempotencyKey: text("idempotency_key").notNull(),
    description: text("description").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("credit_txn_org_idem_uq").on(t.orgId, t.idempotencyKey), index("credit_txn_org_idx").on(t.orgId)],
);

export const creditEntry = sqliteTable(
  "credit_entry",
  {
    id: text("id").primaryKey(),
    txnId: text("txn_id").notNull().references(() => creditTxn.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull().references(() => org.id, { onDelete: "cascade" }),
    // "org" = the customer's balance; "platform" = Showrium's side of the entry.
    account: text("account", { enum: ["org", "platform"] }).notNull(),
    amount: integer("amount").notNull(),
  },
  (t) => [index("credit_entry_org_account_idx").on(t.orgId, t.account), index("credit_entry_txn_idx").on(t.txnId)],
);

// ---------------------------------------------------------------------------
// Audit log: append-only record of who did what.
// ---------------------------------------------------------------------------

export const auditEvent = sqliteTable(
  "audit_event",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => org.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id"),
    actorApiKeyId: text("actor_api_key_id"),
    action: text("action").notNull(),
    target: text("target"),
    meta: text("meta", { mode: "json" }),
    createdAt: createdAt(),
  },
  (t) => [index("audit_event_org_idx").on(t.orgId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Waitlist: people asking for access while production is invite-only.
// Only the email is stored (lowercased), plus when they joined and when they were invited.
// ---------------------------------------------------------------------------

export const waitlistEntry = sqliteTable("waitlist_entry", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  source: text("source").notNull().default("website"),
  invitedAt: integer("invited_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Invites: single-use links created by platform admins. They let a person create an
// account with any sign-in email, in waitlist or allowlist mode. Only a token hash is stored.
// ---------------------------------------------------------------------------

export const invite = sqliteTable(
  "invite",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    note: text("note"),
    createdByUserId: text("created_by_user_id"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    acceptedByUserId: text("accepted_by_user_id"),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("invite_created_idx").on(t.createdAt)],
);

// ---------------------------------------------------------------------------
// Phase 2: persona, sources, context, briefs, drafts, usage.
// ---------------------------------------------------------------------------

export const PLATFORMS = [
  "linkedin",
  "x",
  "instagram",
  "facebook",
  "threads",
  "bluesky",
  "mastodon",
  "tiktok",
  "youtube_shorts",
] as const;
export type Platform = (typeof PLATFORMS)[number];

export const CONTENT_MODES = ["smile", "teach", "expert_take", "build_in_public", "promote"] as const;
export type ContentMode = (typeof CONTENT_MODES)[number];

export const IMAGE_SOURCES = ["upload", "link", "screenshot", "card", "ai"] as const;
export type ImageSource = (typeof IMAGE_SOURCES)[number];
export const IMAGE_SIZES = ["square", "portrait", "landscape", "none"] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];
export type PostImage = { key: string; source: ImageSource; alt: string; mime: string; bytes: number; width?: number | undefined; height?: number | undefined; aiGenerated: boolean; sourceUrl?: string | undefined };

/** Image preferences per workspace: the size each platform gets, and what Showrium may do on its own. */
export const imageSetting = sqliteTable("image_setting", {
  orgId: text("org_id").primaryKey().references(() => org.id, { onDelete: "cascade" }),
  sizes: text("sizes", { mode: "json" }).$type<Partial<Record<Platform, ImageSize>>>().notNull().default(sql`'{}'`),
  /** Find an image for new posts automatically (from your photo, the link, or a screenshot). */
  auto: integer("auto", { mode: "boolean" }).notNull().default(true),
  /** Allow AI-made images when there's no real one (always labelled). */
  allowAi: integer("allow_ai", { mode: "boolean" }).notNull().default(true),
  updatedAt: updatedAt(),
});

/** Who the user is and how they sound. One per workspace for now (brands come later). */
export const persona = sqliteTable("persona", {
  orgId: text("org_id").primaryKey().references(() => org.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  role: text("role").notNull().default(""),
  expertise: text("expertise", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  interests: text("interests", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  audience: text("audience").notNull().default(""),
  voice: text("voice").notNull().default(""),
  avoid: text("avoid", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  blockers: text("blockers", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  /** Platforms the user chose. Nothing is preselected. */
  platforms: text("platforms", { mode: "json" }).$type<Platform[]>().notNull().default(sql`'[]'`),
  /** Monetization-safe mode: approval required, no autopilot, X via tap-to-post. */
  monetizationSafe: integer("monetization_safe", { mode: "boolean" }).notNull().default(false),
  updatedAt: updatedAt(),
});

/** github_repo; rss (a feed); page (a blog or news page without a feed, watched for new article links). */
export const SOURCE_KINDS = ["github_repo", "rss", "page"] as const;
export const source = sqliteTable(
  "source",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => org.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: SOURCE_KINDS }).notNull(),
    /** "owner/repo" for GitHub, a feed URL for RSS, the page URL for a watched page. */
    key: text("key").notNull(),
    /** Watched pages: article links already seen, so only new ones become ideas (newest first, capped). */
    seen: text("seen", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    lastCheckedAt: integer("last_checked_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("source_org_kind_key_uq").on(t.orgId, t.kind, t.key)],
);

export const CONTEXT_KINDS = ["manual", "url", "github_release", "github_activity", "rss_item", "voice", "photo", "document", "prompt"] as const;
export const contextItem = sqliteTable(
  "context_item",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => org.id, { onDelete: "cascade" }),
    sourceId: text("source_id").references(() => source.id, { onDelete: "set null" }),
    kind: text("kind", { enum: CONTEXT_KINDS }).notNull(),
    title: text("title").notNull().default(""),
    body: text("body").notNull(),
    url: text("url"),
    /** Dedup key from the source (release id, feed guid). */
    externalId: text("external_id"),
    /** Uploaded photo or document in the private R2 bucket (orgs/<org>/uploads/<id>), if any. */
    mediaKey: text("media_key"),
    createdAt: createdAt(),
  },
  (t) => [index("context_org_created_idx").on(t.orgId, t.createdAt), uniqueIndex("context_org_external_uq").on(t.orgId, t.externalId)],
);

export const brief = sqliteTable(
  "brief",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => org.id, { onDelete: "cascade" }),
    contextItemId: text("context_item_id").references(() => contextItem.id, { onDelete: "set null" }),
    mode: text("mode", { enum: CONTENT_MODES }).notNull(),
    angle: text("angle").notNull(),
    keyPoints: text("key_points", { mode: "json" }).$type<string[]>().notNull(),
    model: text("model").notNull(),
    costMicroUsd: integer("cost_micro_usd").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("brief_org_idx").on(t.orgId, t.createdAt)],
);

export const DRAFT_STATUSES = ["draft", "approved", "scheduled", "publishing", "published", "failed", "discarded"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];
export const draft = sqliteTable(
  "draft",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => org.id, { onDelete: "cascade" }),
    briefId: text("brief_id").references(() => brief.id, { onDelete: "set null" }),
    platform: text("platform", { enum: PLATFORMS }).notNull(),
    text: text("text").notNull(),
    status: text("status", { enum: DRAFT_STATUSES }).notNull().default("draft"),
    /** Policy lint results: [{code, severity, message}]. */
    issues: text("issues", { mode: "json" }).$type<{ code: string; severity: "error" | "warn"; message: string }[]>().notNull().default(sql`'[]'`),
    aiGenerated: integer("ai_generated", { mode: "boolean" }).notNull().default(true),
    scheduledAt: integer("scheduled_at", { mode: "timestamp_ms" }),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    /** Account to publish to (API path) and how it was published. */
    connectionId: text("connection_id"),
    publishMethod: text("publish_method", { enum: ["api", "tap_to_post", "manual"] }),
    externalPostId: text("external_post_id"),
    externalUrl: text("external_url"),
    lastError: text("last_error"),
    /** A thread: the parts in order (null for a single post). `text` holds them joined, for search and display. */
    parts: text("parts", { mode: "json" }).$type<string[] | null>(),
    /** Thread parts already posted (in order), so a retry continues instead of posting twice. */
    postedParts: text("posted_parts", { mode: "json" }).$type<{ id: string; cid?: string | undefined; url: string | null }[] | null>(),
    /** The post's one image (Sprint 6), stored privately in R2. */
    image: text("image", { mode: "json" }).$type<PostImage | null>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("draft_org_status_idx").on(t.orgId, t.status, t.createdAt), index("draft_due_idx").on(t.status, t.scheduledAt)],
);

/** Posts generated per workspace per calendar month (UTC), for plan quotas. */
export const usageCounter = sqliteTable(
  "usage_counter",
  {
    orgId: text("org_id").notNull().references(() => org.id, { onDelete: "cascade" }),
    period: text("period").notNull(),
    postsGenerated: integer("posts_generated").notNull().default(0),
    videosRendered: integer("videos_rendered").notNull().default(0),
    xApiPosts: integer("x_api_posts").notNull().default(0),
  },
  (t) => [uniqueIndex("usage_org_period_uq").on(t.orgId, t.period)],
);

// ---------------------------------------------------------------------------
// Phase 3: connected social accounts and publishing.
// Tokens are AES-GCM encrypted (key: TOKEN_ENCRYPTION_KEY secret) and never leave the server.
// ---------------------------------------------------------------------------

export const CONNECTION_PLATFORMS = ["x", "linkedin", "tiktok", "bluesky", "mastodon"] as const;
export type ConnectionPlatform = (typeof CONNECTION_PLATFORMS)[number];

export const connection = sqliteTable(
  "connection",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => org.id, { onDelete: "cascade" }),
    platform: text("platform", { enum: CONNECTION_PLATFORMS }).notNull(),
    accountId: text("account_id").notNull(),
    handle: text("handle").notNull(),
    /** Encrypted JSON: access/refresh tokens, or a Bluesky app password. */
    secret: text("secret").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    /** Non-secret extras, e.g. the Mastodon instance or Bluesky PDS. */
    meta: text("meta", { mode: "json" }).$type<Record<string, string>>().notNull().default(sql`'{}'`),
    status: text("status", { enum: ["active", "needs_reconnect"] }).notNull().default("active"),
    createdByUserId: text("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("connection_org_platform_account_uq").on(t.orgId, t.platform, t.accountId), index("connection_org_idx").on(t.orgId)],
);

/** One-time OAuth state (CSRF + PKCE). Consumed on callback; expires after 10 minutes. */
export const oauthState = sqliteTable("oauth_state", {
  state: text("state").primaryKey(),
  orgId: text("org_id").notNull(),
  userId: text("user_id").notNull(),
  platform: text("platform", { enum: CONNECTION_PLATFORMS }).notNull(),
  codeVerifier: text("code_verifier").notNull(),
  meta: text("meta", { mode: "json" }).$type<Record<string, string>>().notNull().default(sql`'{}'`),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

/** Mastodon apps registered per instance (client credentials, encrypted). */
export const mastodonApp = sqliteTable("mastodon_app", {
  instance: text("instance").primaryKey(),
  secret: text("secret").notNull(),
  createdAt: createdAt(),
});


// ---------------------------------------------------------------------------
// Phase 4: video projects. The AI plans a timeline (JSON); the browser renders it.
// ---------------------------------------------------------------------------

export type VideoScene =
  | { kind: "title"; heading: string; body?: string; durationMs: number }
  | { kind: "text"; body: string; durationMs: number }
  | { kind: "bullets"; heading?: string; lines: string[]; durationMs: number }
  | { kind: "code"; heading?: string; code: string; durationMs: number }
  | { kind: "quote"; body: string; attribution?: string; durationMs: number }
  | { kind: "outro"; heading: string; body?: string; durationMs: number };

export interface VideoTimeline {
  title: string;
  narration: string;
  aspect: "9:16" | "1:1" | "16:9";
  scenes: VideoScene[];
}

export const videoProject = sqliteTable(
  "video_project",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => org.id, { onDelete: "cascade" }),
    draftId: text("draft_id"),
    contextItemId: text("context_item_id"),
    timeline: text("timeline", { mode: "json" }).$type<VideoTimeline>().notNull(),
    model: text("model").notNull(),
    revisions: integer("revisions").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("video_org_idx").on(t.orgId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Phase 5: autonomy and learning. Ideas from sources, autopilot rules, engagement, insights.
// ---------------------------------------------------------------------------

export const IDEA_STATUSES = ["new", "drafted", "dismissed"] as const;
/** A post-worthy moment found in a source (a release, a new article). */
export const idea = sqliteTable(
  "idea",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => org.id, { onDelete: "cascade" }),
    contextItemId: text("context_item_id").notNull().references(() => contextItem.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    score: integer("score").notNull().default(0),
    status: text("status", { enum: IDEA_STATUSES }).notNull().default("new"),
    draftedAt: integer("drafted_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("idea_org_context_uq").on(t.orgId, t.contextItemId), index("idea_org_status_idx").on(t.orgId, t.status, t.score)],
);

/** 0 coach (ideas only), 1 drafts, 2 batch (drafts + approve in one tap), 3 autopilot (schedules clean posts). */
export const AUTOPILOT_LEVELS = ["coach", "drafts", "batch", "autopilot"] as const;
export type AutopilotLevel = (typeof AUTOPILOT_LEVELS)[number];
/** What automation may do on one platform. Each switch is independent. */
export type AutomationRule = { write: boolean; schedule: boolean; approve: boolean };
export const autopilot = sqliteTable(
  "autopilot",
  {
    orgId: text("org_id").primaryKey().references(() => org.id, { onDelete: "cascade" }),
    level: text("level", { enum: AUTOPILOT_LEVELS }).notNull().default("coach"),
    mode: text("mode", { enum: CONTENT_MODES }).notNull().default("build_in_public"),
    platforms: text("platforms", { mode: "json" }).$type<Platform[]>().notNull().default(sql`'[]'`),
    postsPerWeek: integer("posts_per_week").notNull().default(3),
    /** Hour of day (UTC) that autopilot schedules posts for. */
    publishHourUtc: integer("publish_hour_utc").notNull().default(14),
    // Sprint 3: independent switches. `level` above is kept in sync (the most any platform allows),
    // so the scheduler can still find workspaces with something switched on.
    /** Check sources for new ideas automatically. */
    findIdeas: integer("find_ideas", { mode: "boolean" }).notNull().default(true),
    /** Per platform: write drafts, schedule when approved, approve for me. */
    rules: text("rules", { mode: "json" }).$type<Partial<Record<Platform, AutomationRule>>>().notNull().default(sql`'{}'`),
    /** Posts per week in each style, e.g. { build_in_public: 2, teach: 1 }. */
    mix: text("mix", { mode: "json" }).$type<Partial<Record<ContentMode, number>>>().notNull().default(sql`'{}'`),
    /** Days of the week to post on (0 = Sunday, UTC). */
    days: text("days", { mode: "json" }).$type<number[]>().notNull().default(sql`'[0,1,2,3,4,5,6]'`),
    /** Styles written in the last 7 days, to follow the mix. */
    weekLog: text("week_log", { mode: "json" }).$type<{ at: number; mode: ContentMode }[]>().notNull().default(sql`'[]'`),
    lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }),
    updatedAt: updatedAt(),
  },
  (t) => [index("autopilot_run_idx").on(t.level, t.lastRunAt)],
);

/** Replies and comments on published posts: from platform APIs (Bluesky, Mastodon) or pasted by the user. */
export const engagement = sqliteTable(
  "engagement",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => org.id, { onDelete: "cascade" }),
    draftId: text("draft_id").notNull().references(() => draft.id, { onDelete: "cascade" }),
    platform: text("platform", { enum: PLATFORMS }).notNull(),
    origin: text("origin", { enum: ["api", "manual"] }).notNull(),
    /** Platform id of the reply (dedup); null for pasted comments. */
    externalId: text("external_id"),
    author: text("author").notNull().default(""),
    text: text("text").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("engagement_org_external_uq").on(t.orgId, t.externalId), index("engagement_org_created_idx").on(t.orgId, t.createdAt), index("engagement_draft_idx").on(t.draftId)],
);

/** Post metrics, refreshed by the listener or entered by the user. */
export const postMetrics = sqliteTable("post_metrics", {
  draftId: text("draft_id").primaryKey().references(() => draft.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => org.id, { onDelete: "cascade" }),
  likes: integer("likes").notNull().default(0),
  replies: integer("replies").notNull().default(0),
  reposts: integer("reposts").notNull().default(0),
  checkedAt: integer("checked_at", { mode: "timestamp_ms" }).notNull(),
});

export type InsightTheme = {
  label: string;
  kind: "question" | "objection" | "praise" | "request" | "other";
  count: number;
  examples: string[];
  suggestion: string;
};
/** What the audience is saying, clustered by the AI from recent comments. */
export const insight = sqliteTable(
  "insight",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => org.id, { onDelete: "cascade" }),
    themes: text("themes", { mode: "json" }).$type<InsightTheme[]>().notNull(),
    basedOn: integer("based_on").notNull(),
    model: text("model").notNull(),
    costMicroUsd: integer("cost_micro_usd").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("insight_org_idx").on(t.orgId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Phase 6: billing and teams.
// ---------------------------------------------------------------------------

export const PAID_PLANS = ["lite", "starter", "creator", "pro", "team"] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];
export const BILLING_PROVIDERS = ["paystack", "lemonsqueezy"] as const;
export type BillingProvider = (typeof BILLING_PROVIDERS)[number];

/** One subscription per workspace. The org's plan follows it (see core/billing.ts). */
export const subscription = sqliteTable(
  "subscription",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().unique().references(() => org.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: BILLING_PROVIDERS }).notNull(),
    plan: text("plan", { enum: PAID_PLANS }).notNull(),
    interval: text("interval", { enum: ["month", "year"] }).notNull(),
    status: text("status", { enum: ["active", "past_due", "cancelled", "expired"] }).notNull(),
    providerSubscriptionId: text("provider_subscription_id").notNull(),
    providerCustomerId: text("provider_customer_id"),
    currentPeriodEnd: integer("current_period_end", { mode: "timestamp_ms" }),
    /** The provider's own last-change time; older events arriving late are ignored. */
    providerUpdatedAt: integer("provider_updated_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("subscription_provider_sub_uq").on(t.provider, t.providerSubscriptionId)],
);

/** Every webhook event seen, keyed so a retried delivery is applied once. No raw payloads (they hold PII). */
export const paymentEvent = sqliteTable(
  "payment_event",
  {
    id: text("id").primaryKey(),
    provider: text("provider", { enum: BILLING_PROVIDERS }).notNull(),
    eventKey: text("event_key").notNull(),
    type: text("type").notNull(),
    orgId: text("org_id"),
    outcome: text("outcome").notNull().default("received"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("payment_event_provider_key_uq").on(t.provider, t.eventKey), index("payment_event_org_idx").on(t.orgId, t.createdAt)],
);

/** Invitations to join a workspace. Bound to one email address; only a token hash is stored. */
export const teamInvite = sqliteTable(
  "team_invite",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => org.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ROLES }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedByUserId: text("invited_by_user_id"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    acceptedByUserId: text("accepted_by_user_id"),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("team_invite_org_idx").on(t.orgId, t.createdAt)],
);
