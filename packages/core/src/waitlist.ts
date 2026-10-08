import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { invite, user, waitlistEntry, type Db } from "@nextrium/db";
import { chunkRows } from "./chunk.js";
import { newId } from "./ids.js";
import { createInvite } from "./invites.js";

/**
 * Adds an email to the waitlist. Idempotent: joining twice changes nothing.
 * Callers must give the same response either way, so the endpoint can't be used
 * to find out whether someone has signed up.
 */
export async function joinWaitlist(db: Db, email: string, source = "website"): Promise<void> {
  await db
    .insert(waitlistEntry)
    .values({ id: newId("wl"), email: email.trim().toLowerCase(), source })
    .onConflictDoNothing({ target: waitlistEntry.email });
}

export type WaitlistStatus = "waiting" | "invited" | "invite_expired" | "joined";
export type WaitlistRow = { id: string; email: string; source: string; joinedListAt: Date; invitedAt: Date | null; status: WaitlistStatus; joinedAt: Date | null };

/**
 * The waitlist with where each person is: waiting, invited (link still valid), invite expired,
 * or joined (their invite was used, or they have an account with that email).
 */
export async function listWaitlist(db: Db, now = Date.now()): Promise<WaitlistRow[]> {
  const rows = await db
    .select({
      id: waitlistEntry.id,
      email: waitlistEntry.email,
      source: waitlistEntry.source,
      createdAt: waitlistEntry.createdAt,
      invitedAt: waitlistEntry.invitedAt,
      acceptedAt: invite.acceptedAt,
      expiresAt: invite.expiresAt,
      revokedAt: invite.revokedAt,
    })
    .from(waitlistEntry)
    .leftJoin(invite, eq(invite.id, waitlistEntry.inviteId))
    .orderBy(desc(waitlistEntry.createdAt))
    .limit(1000);
  // People who already have an account with that email (joined some other way, or after an invite).
  const accounts = new Map<string, Date>();
  for (const chunk of chunkRows([...new Set(rows.map((r) => r.email))], 1)) {
    for (const u of await db.select({ email: user.email, createdAt: user.createdAt }).from(user).where(inArray(user.email, chunk))) accounts.set(u.email.toLowerCase(), u.createdAt);
  }
  return rows.map((r) => {
    const joinedAt = r.acceptedAt ?? accounts.get(r.email) ?? null;
    const status: WaitlistStatus = joinedAt
      ? "joined"
      : r.invitedAt && r.expiresAt && !r.revokedAt && r.expiresAt.getTime() > now
        ? "invited"
        : r.invitedAt
          ? "invite_expired"
          : "waiting";
    return { id: r.id, email: r.email, source: r.source, joinedListAt: r.createdAt, invitedAt: r.invitedAt, status, joinedAt };
  });
}

/**
 * Creates a single-use invite link for each waitlist entry (a new one replaces an unused older one)
 * and records it. People who already joined are skipped. Returns what to email.
 * The link lets them create their own account and workspace (Free plan), never a place in anyone else's.
 */
export async function inviteFromWaitlist(db: Db, input: { entryIds: string[]; adminUserId: string; now?: number }) {
  const ids = [...new Set(input.entryIds)].slice(0, 50);
  if (!ids.length) return [];
  const current = new Map((await listWaitlist(db, input.now)).map((r) => [r.id, r]));
  const entries = await db.select().from(waitlistEntry).where(inArray(waitlistEntry.id, ids));
  const out: { entryId: string; email: string; token: string; expiresAt: Date }[] = [];
  for (const e of entries) {
    if (current.get(e.id)?.status === "joined") continue;
    // An older, unused link stops working: only the newest one is valid.
    if (e.inviteId) await db.update(invite).set({ revokedAt: new Date(input.now ?? Date.now()) }).where(and(eq(invite.id, e.inviteId), isNull(invite.acceptedAt), isNull(invite.revokedAt)));
    const created = await createInvite(db, { createdByUserId: input.adminUserId, note: `Waitlist: ${e.email}`.slice(0, 120), ...(input.now ? { now: input.now } : {}) });
    await db.update(waitlistEntry).set({ invitedAt: new Date(input.now ?? Date.now()), inviteId: created.id }).where(eq(waitlistEntry.id, e.id));
    out.push({ entryId: e.id, email: e.email, token: created.token, expiresAt: created.expiresAt });
  }
  return out;
}
