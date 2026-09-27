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
