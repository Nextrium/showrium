// Connected accounts and publishing. Tokens are decrypted only here, just before use.
import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import { connection, draft, mastodonApp, oauthState, persona, type ConnectionPlatform, type Db } from "@nextrium/db";
import { bluesky, linkedin, mastodon, PlatformError, tiktok, x, type Account, type FetchLike, type OAuthConfig, type ImageUpload, type ReplyTo, type TokenSet } from "@nextrium/platforms";
import { hasErrors, X_LONG_SUBSCRIPTIONS, xWeightedLength } from "@nextrium/policy";
import { postCreditTxn, InsufficientCreditsError } from "./credits.js";
import { decryptJson, encryptJson, pkceChallenge, randomToken } from "./crypto.js";
import { newId } from "./ids.js";
import { imagesForPublishing, type ImageStore } from "./images.js";
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
  /** Where post images live (R2). Without it, posts go out without their image. */
  media?: ImageStore | undefined;
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

type SendCache = { bluesky?: { service: string; accessJwt: string; account: Account }; imageNotes?: string[] };

async function sendToPlatform(deps: PublishDeps, conn: typeof connection.$inferSelect, text: string, idempotencyKey: string, replyTo?: ReplyTo, cache: SendCache = {}, images: ImageUpload[] = []) {
  const account = { accountId: conn.accountId, handle: conn.handle };
  const key = aad(conn.orgId, conn.platform, conn.accountId);
  // Images are uploaded first, one by one. One that fails (too big, unsupported, missing permission)
  // is left out, and the reason is kept to show the person; the post still goes out with the rest.
  // An image problem never marks the account broken.
  const attachAll = async <T>(upload: (image: ImageUpload) => Promise<T>): Promise<{ value: T; image: ImageUpload }[]> => {
    const out: { value: T; image: ImageUpload }[] = [];
    for (const [i, image] of images.entries()) {
      if (conn.platform === "linkedin" && !["image/jpeg", "image/png", "image/gif"].includes(image.mime)) {
        (cache.imageNotes ??= []).push(`Image ${i + 1}: LinkedIn takes JPG, PNG or GIF only.`);
        continue;
      }
      try {
        out.push({ value: await upload(image), image });
      } catch (error) {
        const why = error instanceof PlatformError && error.kind !== "auth" ? error.message : `${PLATFORM_NAMES[conn.platform] ?? conn.platform} didn't accept it. Reconnect the account to allow images, then post again.`;
        (cache.imageNotes ??= []).push(`Image ${i + 1}: ${why}`);
      }
    }
    return out;
  };
  switch (conn.platform) {
    case "x": {
      const tokens = await freshTokens(deps, conn, await decryptJson<OAuthSecret>(deps.key, conn.secret, key));
      const media = await attachAll((image) => x.uploadImage(tokens, image, deps.fetch));
      return x.publish(tokens, account, text, deps.fetch, replyTo, media.map((m) => m.value));
    }
    case "linkedin": {
      const tokens = await freshTokens(deps, conn, await decryptJson<OAuthSecret>(deps.key, conn.secret, key));
      const media = await attachAll((image) => linkedin.uploadImage(tokens, account, image, deps.fetch));
      return linkedin.publish(tokens, account, text, deps.fetch, media.map((m) => ({ urn: m.value, alt: m.image.alt })));
    }
    case "mastodon": {
      const { tokens } = await decryptJson<OAuthSecret>(deps.key, conn.secret, key);
      const media = await attachAll((image) => mastodon.uploadImage(conn.meta.instance!, tokens, image, deps.fetch));
      return mastodon.publish(conn.meta.instance!, tokens, text, idempotencyKey, deps.fetch, replyTo, media.map((m) => m.value));
    }
    case "bluesky": {
      // One session per publish, reused across a thread's parts.
      if (!cache.bluesky) {
        const s = await decryptJson<BlueskySecret>(deps.key, conn.secret, key);
        const service = conn.meta.service ?? "https://bsky.social";
        const session = await bluesky.session(service, s.identifier, s.appPassword, deps.fetch);
        cache.bluesky = { service, accessJwt: session.accessJwt, account: session.account };
      }
      const b = cache.bluesky;
      const media = await attachAll((image) => bluesky.uploadImage(b.service, b.accessJwt, image, deps.fetch));
      return bluesky.publish(b.service, b.accessJwt, b.account, text, deps.fetch, replyTo, media.map((m) => ({ blob: m.value, alt: m.image.alt, width: m.image.width, height: m.image.height })));
    }
    default:
      throw new PublishError("not_supported", "Publishing to this platform arrives with video support.");
  }
}

const PLATFORM_NAMES: Record<string, string> = { x: "X", linkedin: "LinkedIn", mastodon: "Mastodon", bluesky: "Bluesky" };

/** Before a long X post: confirm the account still has a subscription that allows it (one read). */
async function confirmXLong(deps: PublishDeps, conn: typeof connection.$inferSelect) {
  const tokens = await freshTokens(deps, conn, await decryptJson<OAuthSecret>(deps.key, conn.secret, aad(conn.orgId, conn.platform, conn.accountId)));
  const acct = await x.account(tokens, deps.fetch);
  if (acct.subscription !== conn.meta.subscription) {
    await deps.db.update(connection).set({ meta: { ...conn.meta, subscription: acct.subscription ?? "None" }, updatedAt: new Date() }).where(eq(connection.id, conn.id));
  }
  if (!X_LONG_SUBSCRIPTIONS.includes(acct.subscription ?? "")) {
    throw new PublishError("has_errors", "Your X account doesn't have Premium any more, so posts must be 280 characters or fewer. Shorten this post or make it a thread.");
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

  // A thread posts its parts as a chain of replies. Parts already posted (from an earlier try) are skipped.
  const isThread = Boolean(d.parts && d.parts.length > 1);
  const parts = isThread ? d.parts! : [d.text];
  let posted = isThread ? [...(d.postedParts ?? [])] : [];
  const startAt = posted.length;
  const remaining = parts.slice(startAt);

  // X charges per API post: plan allowance first, then credits (links cost more). Each part is a post.
  const partCharge: number[] = remaining.map(() => 0);
  if (conn.platform === "x") {
    const plan = await getOrgPlan(db, input.orgId);
    const { overage } = await addUsage(db, input.orgId, "xApiPosts", remaining.length, PLAN_LIMITS[plan].xApiPosts);
    for (let i = remaining.length - overage; i < remaining.length; i++) partCharge[i] = /https?:\/\//i.test(remaining[i]!) ? CREDITS_PER_X_API_POST_WITH_LINK : CREDITS_PER_X_API_POST;
    const charged = partCharge.reduce((a, b) => a + b, 0);
    if (charged > 0) {
      try {
        await postCreditTxn(db, { orgId: input.orgId, kind: "spend", amount: -charged, idempotencyKey: `x-post:${d.id}:${startAt}`, description: remaining.length > 1 ? `X thread via API (${remaining.length} posts)` : "X post via API" });
      } catch (error) {
        await addUsage(db, input.orgId, "xApiPosts", -remaining.length, PLAN_LIMITS[plan].xApiPosts);
        await db.update(draft).set({ status: d.status, updatedAt: new Date() }).where(eq(draft.id, d.id));
        if (error instanceof InsufficientCreditsError) throw new PublishError("insufficient_credits", `Posting to X through the API needs ${charged} credits. Use tap-to-post (free) or add credits.`);
        throw error;
      }
    }
  }

  const cache: SendCache = {};
  const images = deps.media ? await imagesForPublishing(db, deps.media, input.orgId, d).catch(() => []) : [];
  try {
    if (conn.platform === "x" && !isThread && xWeightedLength(d.text) > 280) await confirmXLong(deps, conn);
    let result: { externalId: string; url: string | null };
    if (!isThread) {
      result = await sendToPlatform(deps, conn, d.text, d.id, undefined, cache, images);
    } else {
      for (let i = startAt; i < parts.length; i++) {
        const prev = posted[i - 1];
        const root = posted[0];
        const replyTo = prev && root ? { id: prev.id, cid: prev.cid, rootId: root.id, rootCid: root.cid } : undefined;
        // Images go on the first part only.
        const r = await sendToPlatform(deps, conn, parts[i]!, `${d.id}:${i}`, replyTo, cache, i === 0 ? images : []);
        posted = [...posted, { id: r.externalId, cid: r.cid, url: r.url }];
        await db.update(draft).set({ postedParts: posted, updatedAt: new Date() }).where(eq(draft.id, d.id));
      }
      result = { externalId: posted[0]!.id, url: posted[0]!.url };
    }
    await db
      .update(draft)
      .set({ status: "published", publishedAt: new Date(), externalPostId: result.externalId, externalUrl: result.url, publishMethod: "api", lastError: cache.imageNotes?.length ? `Posted, but not every image went with it. ${cache.imageNotes.join(" ")}` : null, updatedAt: new Date() })
      .where(eq(draft.id, d.id));
    await recordAudit(db, { orgId: input.orgId, actorUserId: input.actorUserId ?? null, action: "draft.published", target: d.id, meta: { platform: conn.platform, parts: parts.length, images: images.length, imagesLeftOut: cache.imageNotes?.length ?? 0 } });
    return { status: "published" as const, url: result.url };
  } catch (error) {
    const base = error instanceof PlatformError || error instanceof PublishError ? error.message : "Publishing failed unexpectedly.";
    const message = isThread && posted.length > 0 ? `Posted ${posted.length} of ${parts.length} parts. ${base} Try again to post the rest.` : base;
    if (!(error instanceof PlatformError) && !(error instanceof PublishError)) console.error("publish failed", error);
    await db.update(draft).set({ status: "failed", lastError: message, updatedAt: new Date() }).where(eq(draft.id, d.id));
    if (error instanceof PlatformError && error.kind === "auth") {
      await db.update(connection).set({ status: "needs_reconnect", updatedAt: new Date() }).where(eq(connection.id, conn.id));
    }
    // Give back the allowance and credits for the parts that didn't go out.
    if (conn.platform === "x") {
      const sentNow = posted.length - startAt;
      const unsent = remaining.length - sentNow;
      const refund = partCharge.slice(sentNow).reduce((a, b) => a + b, 0);
      const plan = await getOrgPlan(db, input.orgId);
      if (unsent > 0) await addUsage(db, input.orgId, "xApiPosts", -unsent, PLAN_LIMITS[plan].xApiPosts).catch(() => undefined);
      if (refund > 0) {
        await postCreditTxn(db, { orgId: input.orgId, kind: "refund", amount: refund, idempotencyKey: `x-refund:${d.id}:${Date.now()}`, description: "Refund: X post failed" }).catch(() => undefined);
      }
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
      // Checks that fail before the claim (account disconnected, errors, credits) leave the post
      // "scheduled"; it would be retried every run and, at the head of the queue, block others.
      if (!(error instanceof PublishError && error.code === "conflict")) {
        const message = error instanceof PublishError ? error.message : "Publishing failed unexpectedly.";
        await deps.db
          .update(draft)
          .set({ status: "failed", lastError: message, updatedAt: new Date() })
          .where(and(eq(draft.id, d.id), eq(draft.status, "scheduled")));
      }
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

/** Housekeeping: removes OAuth states that expired without being used (abandoned sign-ins). */
export async function pruneExpiredOAuthStates(db: Db, now = new Date()) {
  const removed = await db.delete(oauthState).where(lte(oauthState.expiresAt, now)).returning({ state: oauthState.state });
  return removed.length;
}

/**
 * Housekeeping: a post stays "publishing" only if its run died mid-way (limits, deploy, crash).
 * After 15 minutes it becomes "failed" with a note; we can't know whether the platform received it,
 * so the user checks before retrying rather than risking a duplicate.
 */
export async function recoverStuckPublishing(db: Db, now = new Date()) {
  const stuck = await db
    .update(draft)
    .set({ status: "failed", lastError: "Publishing was interrupted. Check the platform before trying again.", updatedAt: now })
    .where(and(eq(draft.status, "publishing"), lte(draft.updatedAt, new Date(now.getTime() - 15 * 60_000))))
    .returning({ id: draft.id });
  return stuck.length;
}
