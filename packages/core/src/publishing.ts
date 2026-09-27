// Connected accounts and publishing. Tokens are decrypted only here, just before use.
import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import { connection, draft, mastodonApp, oauthState, persona, type ConnectionPlatform, type Db } from "@nextrium/db";
import { bluesky, linkedin, mastodon, PlatformError, tiktok, x, type Account, type FetchLike, type OAuthConfig, type TokenSet } from "@nextrium/platforms";
import { hasErrors } from "@nextrium/policy";
import { postCreditTxn, InsufficientCreditsError } from "./credits.js";
import { decryptJson, encryptJson, pkceChallenge, randomToken } from "./crypto.js";
import { newId } from "./ids.js";
import { recordAudit } from "./orgs.js";
import { getOrgPlan } from "./content.js";
import { addUsage, CREDITS_PER_X_API_POST, CREDITS_PER_X_API_POST_WITH_LINK, PLAN_LIMITS } from "./plans.js";

export interface PlatformConfigs {
  x?: OAuthConfig | undefined;
  linkedin?: OAuthConfig | undefined;
  tiktok?: OAuthConfig | undefined;
  mastodonRedirectUri: string;
}
export interface PublishDeps {
  db: Db;
  key: CryptoKey;
  configs: PlatformConfigs;
  fetch?: FetchLike | undefined;
}

type OAuthSecret = { tokens: TokenSet };
type BlueskySecret = { identifier: string; appPassword: string };

const aad = (orgId: string, platform: string, accountId: string) => `${orgId}:${platform}:${accountId}`;

// --- OAuth state (CSRF + PKCE) -------------------------------------------------------

export async function createOAuthState(db: Db, input: { orgId: string; userId: string; platform: ConnectionPlatform; meta?: Record<string, string> }) {
  const state = randomToken(24);
  const codeVerifier = randomToken(48);
  await db.insert(oauthState).values({ state, orgId: input.orgId, userId: input.userId, platform: input.platform, codeVerifier, meta: input.meta ?? {}, expiresAt: new Date(Date.now() + 10 * 60_000) });
  return { state, challenge: await pkceChallenge(codeVerifier) };
}

/** Single use: deleted as it's read, so a replayed callback finds nothing. */
export async function consumeOAuthState(db: Db, state: string) {
  const [row] = await db.delete(oauthState).where(and(eq(oauthState.state, state), gt(oauthState.expiresAt, new Date()))).returning();
  return row ?? null;
}

// --- Connections ------------------------------------------------------------------------

export async function saveConnection(
  deps: Pick<PublishDeps, "db" | "key">,
  input: { orgId: string; platform: ConnectionPlatform; account: Account; secret: unknown; expiresAt?: number | undefined; meta?: Record<string, string>; userId: string },
) {
  const secret = await encryptJson(deps.key, input.secret, aad(input.orgId, input.platform, input.account.accountId));
  const values = {
    handle: input.account.handle,
    secret,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    meta: input.meta ?? {},
    status: "active" as const,
    updatedAt: new Date(),
  };
  const [row] = await deps.db
    .insert(connection)
    .values({ id: newId("cn"), orgId: input.orgId, platform: input.platform, accountId: input.account.accountId, createdByUserId: input.userId, ...values })
    .onConflictDoUpdate({ target: [connection.orgId, connection.platform, connection.accountId], set: values })
    .returning({ id: connection.id });
  await recordAudit(deps.db, { orgId: input.orgId, actorUserId: input.userId, action: "connection.saved", target: row!.id, meta: { platform: input.platform } });
  return row!.id;
}

export async function listConnections(db: Db, orgId: string) {
  return db
    .select({ id: connection.id, platform: connection.platform, handle: connection.handle, status: connection.status, meta: connection.meta, expiresAt: connection.expiresAt, createdAt: connection.createdAt })
    .from(connection)
    .where(eq(connection.orgId, orgId))
    .orderBy(asc(connection.createdAt));
}

export async function removeConnection(db: Db, orgId: string, id: string, userId: string | null) {
  const removed = await db.delete(connection).where(and(eq(connection.orgId, orgId), eq(connection.id, id))).returning({ id: connection.id });
  if (removed.length) await recordAudit(db, { orgId, actorUserId: userId, action: "connection.removed", target: id });
  return removed.length > 0;
}

/** Mastodon app credentials per instance, registered once and reused. */
export async function mastodonClient(deps: PublishDeps, instance: string): Promise<OAuthConfig> {
  const [row] = await deps.db.select().from(mastodonApp).where(eq(mastodonApp.instance, instance));
  if (row) {
    const app = await decryptJson<{ clientId: string; clientSecret: string }>(deps.key, row.secret, `mastodon:${instance}`);
    return { ...app, redirectUri: deps.configs.mastodonRedirectUri };
  }
  const app = await mastodon.registerApp(instance, deps.configs.mastodonRedirectUri, deps.fetch);
  await deps.db.insert(mastodonApp).values({ instance, secret: await encryptJson(deps.key, app, `mastodon:${instance}`) }).onConflictDoNothing();
  return { ...app, redirectUri: deps.configs.mastodonRedirectUri };
}

// --- Publishing ---------------------------------------------------------------------------

export class PublishError extends Error {
  constructor(
    readonly code: "not_found" | "not_ready" | "has_errors" | "no_connection" | "not_supported" | "monetization_safe" | "insufficient_credits" | "platform_error" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

export const API_PUBLISH_PLATFORMS: ConnectionPlatform[] = ["x", "linkedin", "bluesky", "mastodon"];
const READY = ["approved", "scheduled", "failed"] as const;

async function loadConnection(deps: PublishDeps, orgId: string, id: string) {
  const [row] = await deps.db.select().from(connection).where(and(eq(connection.orgId, orgId), eq(connection.id, id)));
  return row ?? null;
}

async function freshTokens(deps: PublishDeps, conn: typeof connection.$inferSelect, secret: OAuthSecret): Promise<TokenSet> {
  const soon = Date.now() + 60_000;
  if (!secret.tokens.expiresAt || secret.tokens.expiresAt > soon || !secret.tokens.refreshToken) return secret.tokens;
  const cfg = conn.platform === "x" ? deps.configs.x : conn.platform === "tiktok" ? deps.configs.tiktok : undefined;
  const refresher = conn.platform === "x" ? x.refresh : conn.platform === "tiktok" ? tiktok.refresh : undefined;
  if (!cfg || !refresher) return secret.tokens;
  const tokens = await refresher(cfg, secret.tokens.refreshToken, deps.fetch);
  await deps.db
    .update(connection)
    .set({ secret: await encryptJson(deps.key, { tokens }, aad(conn.orgId, conn.platform, conn.accountId)), expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt) : null, updatedAt: new Date() })
    .where(eq(connection.id, conn.id));
  return tokens;
}

async function sendToPlatform(deps: PublishDeps, conn: typeof connection.$inferSelect, text: string, draftId: string) {
  const account = { accountId: conn.accountId, handle: conn.handle };
  const key = aad(conn.orgId, conn.platform, conn.accountId);
  switch (conn.platform) {
    case "x":
    case "linkedin": {
      const tokens = await freshTokens(deps, conn, await decryptJson<OAuthSecret>(deps.key, conn.secret, key));
      return (conn.platform === "x" ? x : linkedin).publish(tokens, account, text, deps.fetch);
    }
    case "mastodon": {
      const { tokens } = await decryptJson<OAuthSecret>(deps.key, conn.secret, key);
      return mastodon.publish(conn.meta.instance!, tokens, text, draftId, deps.fetch);
    }
    case "bluesky": {
      const s = await decryptJson<BlueskySecret>(deps.key, conn.secret, key);
      const service = conn.meta.service ?? "https://bsky.social";
      const session = await bluesky.session(service, s.identifier, s.appPassword, deps.fetch);
      return bluesky.publish(service, session.accessJwt, session.account, text, deps.fetch);
    }
    default:
      throw new PublishError("not_supported", "Publishing to this platform arrives with video support.");
  }
}

/**
 * Publishes one draft through the platform API. The draft is claimed atomically
 * (status -> publishing), so two requests or a request and the scheduler can't both post it.
 */
export async function publishDraft(deps: PublishDeps, input: { orgId: string; draftId: string; actorUserId?: string | null }) {
  const { db } = deps;
  const [d] = await db.select().from(draft).where(and(eq(draft.orgId, input.orgId), eq(draft.id, input.draftId)));
  if (!d) throw new PublishError("not_found", "No such post in this workspace.");
  if (!READY.includes(d.status as (typeof READY)[number])) throw new PublishError("not_ready", "Approve the post before publishing it.");
  if (hasErrors(d.issues)) throw new PublishError("has_errors", "Fix the errors on this post first.");
  if (!d.connectionId) throw new PublishError("no_connection", "Choose which connected account to post from.");
  const conn = await loadConnection(deps, input.orgId, d.connectionId);
  if (!conn || conn.platform !== d.platform) throw new PublishError("no_connection", "That account isn't connected any more.");
  if (!API_PUBLISH_PLATFORMS.includes(conn.platform)) throw new PublishError("not_supported", "This platform can't be posted to automatically yet.");

  const [p] = await db.select({ safe: persona.monetizationSafe }).from(persona).where(eq(persona.orgId, input.orgId));
  if (p?.safe && conn.platform === "x") throw new PublishError("monetization_safe", "Monetization-safe mode posts to X through your own X app (tap-to-post).");

  const [claimed] = await db
    .update(draft)
    .set({ status: "publishing", lastError: null, updatedAt: new Date() })
    .where(and(eq(draft.orgId, input.orgId), eq(draft.id, d.id), inArray(draft.status, [...READY])))
    .returning({ id: draft.id });
  if (!claimed) throw new PublishError("conflict", "This post is already being published.");

  // X charges per API post: plan allowance first, then credits (links cost more).
  let charged = 0;
  if (conn.platform === "x") {
    const plan = await getOrgPlan(db, input.orgId);
    const { overage } = await addUsage(db, input.orgId, "xApiPosts", 1, PLAN_LIMITS[plan].xApiPosts);
    if (overage > 0) {
      charged = /https?:\/\//i.test(d.text) ? CREDITS_PER_X_API_POST_WITH_LINK : CREDITS_PER_X_API_POST;
      try {
        await postCreditTxn(db, { orgId: input.orgId, kind: "spend", amount: -charged, idempotencyKey: `x-post:${d.id}`, description: "X post via API" });
      } catch (error) {
        await addUsage(db, input.orgId, "xApiPosts", -1, PLAN_LIMITS[plan].xApiPosts);
        await db.update(draft).set({ status: d.status, updatedAt: new Date() }).where(eq(draft.id, d.id));
        if (error instanceof InsufficientCreditsError) throw new PublishError("insufficient_credits", `Posting to X through the API needs ${charged} credits. Use tap-to-post (free) or add credits.`);
        throw error;
      }
    }
  }

  try {
    const result = await sendToPlatform(deps, conn, d.text, d.id);
    await db
      .update(draft)
      .set({ status: "published", publishedAt: new Date(), externalPostId: result.externalId, externalUrl: result.url, publishMethod: "api", lastError: null, updatedAt: new Date() })
      .where(eq(draft.id, d.id));
    await recordAudit(db, { orgId: input.orgId, actorUserId: input.actorUserId ?? null, action: "draft.published", target: d.id, meta: { platform: conn.platform } });
    return { status: "published" as const, url: result.url };
  } catch (error) {
    const message = error instanceof PlatformError || error instanceof PublishError ? error.message : "Publishing failed unexpectedly.";
    if (!(error instanceof PlatformError)) console.error("publish failed", error);
    await db.update(draft).set({ status: "failed", lastError: message, updatedAt: new Date() }).where(eq(draft.id, d.id));
    if (error instanceof PlatformError && error.kind === "auth") {
      await db.update(connection).set({ status: "needs_reconnect", updatedAt: new Date() }).where(eq(connection.id, conn.id));
    }
    if (charged > 0) {
      await postCreditTxn(db, { orgId: input.orgId, kind: "refund", amount: charged, idempotencyKey: `x-refund:${d.id}:${Date.now()}`, description: "Refund: X post failed" }).catch(() => undefined);
    }
    throw new PublishError("platform_error", message);
  }
}

/** The user posted it themselves via tap-to-post (or copy and paste). */
export async function markPublishedManually(db: Db, orgId: string, draftId: string, url: string | null) {
  const [row] = await db
    .update(draft)
    .set({ status: "published", publishedAt: new Date(), publishMethod: "tap_to_post", externalUrl: url, updatedAt: new Date() })
    .where(and(eq(draft.orgId, orgId), eq(draft.id, draftId), inArray(draft.status, ["approved", "failed", "scheduled"])))
    .returning({ id: draft.id });
  return Boolean(row);
}

export async function scheduleDraft(db: Db, orgId: string, draftId: string, input: { at: Date; connectionId: string }) {
  if (input.at.getTime() < Date.now() + 60_000) throw new PublishError("not_ready", "Pick a time at least a minute from now.");
  if (input.at.getTime() > Date.now() + 90 * 86_400_000) throw new PublishError("not_ready", "Schedule up to 90 days ahead.");
  const [d] = await db.select().from(draft).where(and(eq(draft.orgId, orgId), eq(draft.id, draftId)));
  if (!d) throw new PublishError("not_found", "No such post in this workspace.");
  if (hasErrors(d.issues)) throw new PublishError("has_errors", "Fix the errors on this post first.");
  const [conn] = await db.select().from(connection).where(and(eq(connection.orgId, orgId), eq(connection.id, input.connectionId)));
  if (!conn || conn.platform !== d.platform || !API_PUBLISH_PLATFORMS.includes(conn.platform)) throw new PublishError("no_connection", "Connect an account for this platform first.");
  const [row] = await db
    .update(draft)
    .set({ status: "scheduled", scheduledAt: input.at, connectionId: conn.id, updatedAt: new Date() })
    .where(and(eq(draft.orgId, orgId), eq(draft.id, draftId), inArray(draft.status, ["approved", "failed", "scheduled"])))
    .returning({ id: draft.id });
  if (!row) throw new PublishError("not_ready", "Approve the post before scheduling it.");
  return true;
}

export async function setDraftConnection(db: Db, orgId: string, draftId: string, connectionId: string) {
  const [conn] = await db.select({ platform: connection.platform }).from(connection).where(and(eq(connection.orgId, orgId), eq(connection.id, connectionId)));
  const [d] = await db.select({ platform: draft.platform }).from(draft).where(and(eq(draft.orgId, orgId), eq(draft.id, draftId)));
  if (!conn || !d || conn.platform !== d.platform) return false;
  await db.update(draft).set({ connectionId, updatedAt: new Date() }).where(and(eq(draft.orgId, orgId), eq(draft.id, draftId)));
  return true;
}

/** Publishes scheduled drafts that are due. Called by the cron trigger every 5 minutes. */
export async function runDuePublishing(deps: PublishDeps, now = new Date(), limit = 25) {
  const due = await deps.db
    .select({ id: draft.id, orgId: draft.orgId })
    .from(draft)
    .where(and(eq(draft.status, "scheduled"), lte(draft.scheduledAt, now)))
    .orderBy(asc(draft.scheduledAt))
    .limit(limit);
  let published = 0;
  let failed = 0;
  for (const d of due) {
    try {
      await publishDraft(deps, { orgId: d.orgId, draftId: d.id });
      published++;
    } catch (error) {
      failed++;
      if (!(error instanceof PublishError)) console.error("scheduled publish error", error);
    }
  }
  return { due: due.length, published, failed };
}

/** Decrypted, refreshed OAuth tokens for one of this workspace's connections (server-side use only). */
export async function connectionTokens(deps: PublishDeps, orgId: string, connectionId: string, platform: ConnectionPlatform): Promise<TokenSet | null> {
  const conn = await loadConnection(deps, orgId, connectionId);
  if (!conn || conn.platform !== platform || conn.status !== "active") return null;
  return freshTokens(deps, conn, await decryptJson<OAuthSecret>(deps.key, conn.secret, aad(conn.orgId, conn.platform, conn.accountId)));
}
