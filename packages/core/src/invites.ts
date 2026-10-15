// Single-use invite links. Only the SHA-256 of the token is stored; the link is shown once.
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { invite, type Db } from "@nextrium/db";
import { hashApiKey as sha256Hex } from "./api-keys.js";
import { newId } from "./ids.js";

const TOKEN_PREFIX = "inv_";
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return TOKEN_PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function looksLikeInviteToken(token: string | undefined | null): token is string {
  return typeof token === "string" && token.startsWith(TOKEN_PREFIX) && token.length >= 40 && token.length <= 100;
}

export async function createInvite(db: Db, input: { createdByUserId: string; note?: string | null; now?: number }) {
  const token = randomToken();
  const now = input.now ?? Date.now();
  const row = {
    id: newId("inv"),
    tokenHash: await sha256Hex(token),
    note: input.note?.trim() || null,
    createdByUserId: input.createdByUserId,
    expiresAt: new Date(now + INVITE_TTL_MS),
  };
  await db.insert(invite).values(row);
  return { id: row.id, token, expiresAt: row.expiresAt };
}

/** Usable = exists, not accepted, not revoked, not expired. Doesn't consume it. */
export async function isInviteUsable(db: Db, token: string, now = Date.now()): Promise<boolean> {
  if (!looksLikeInviteToken(token)) return false;
  const [row] = await db
    .select({ id: invite.id })
    .from(invite)
    .where(
      and(
        eq(invite.tokenHash, await sha256Hex(token)),
        isNull(invite.acceptedAt),
        isNull(invite.revokedAt),
        gt(invite.expiresAt, new Date(now)),
      ),
    );
  return Boolean(row);
}

/**
 * Consumes an invite atomically: a single conditional UPDATE, so two sign-ups racing
 * with the same link can't both succeed. Returns true only for the one that claimed it.
 */
export async function claimInvite(db: Db, token: string, now = Date.now()): Promise<boolean> {
  if (!looksLikeInviteToken(token)) return false;
  const claimed = await db
    .update(invite)
    .set({ acceptedAt: new Date(now) })
    .where(
      and(
        eq(invite.tokenHash, await sha256Hex(token)),
        isNull(invite.acceptedAt),
        isNull(invite.revokedAt),
        gt(invite.expiresAt, new Date(now)),
      ),
    )
    .returning({ id: invite.id });
  return claimed.length === 1;
}

export async function recordInviteAcceptedBy(db: Db, token: string, userId: string): Promise<void> {
  if (!looksLikeInviteToken(token)) return;
  await db
    .update(invite)
    .set({ acceptedByUserId: userId })
    .where(and(eq(invite.tokenHash, await sha256Hex(token)), isNull(invite.acceptedByUserId)));
}

export async function listInvites(db: Db) {
  return db
    .select({
      id: invite.id,
      note: invite.note,
      expiresAt: invite.expiresAt,
      acceptedAt: invite.acceptedAt,
      revokedAt: invite.revokedAt,
      createdAt: invite.createdAt,
    })
    .from(invite)
    .orderBy(desc(invite.createdAt))
    .limit(100);
}

export async function revokeInvite(db: Db, id: string): Promise<boolean> {
  const updated = await db
    .update(invite)
    .set({ revokedAt: new Date() })
    .where(and(eq(invite.id, id), isNull(invite.revokedAt), isNull(invite.acceptedAt)))
    .returning({ id: invite.id });
  return updated.length > 0;
}
