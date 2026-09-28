import { and, asc, desc, eq, lt } from "drizzle-orm";
import { auditEvent, membership, org, type Db, type Role } from "@nextrium/db";
import { postCreditTxn } from "./credits.js";
import { newId } from "./ids.js";

/** Credits every new workspace starts with during the beta (1 credit = $0.01). */
export const WELCOME_CREDITS = 20;

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "workspace";
  return `${base}-${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36).slice(0, 5)}`;
}

/**
 * Creates the user's personal workspace, makes them owner, and grants the welcome credits.
 * At most one per user: a concurrent second call hits the unique index and returns null.
 */
export async function createPersonalOrg(db: Db, input: { userId: string; userName: string }) {
  const orgId = newId("org");
  const name = `${input.userName.trim().split(/\s+/)[0] || "My"}'s workspace`;
  try {
    await db.batch([
      db.insert(org).values({ id: orgId, name, slug: slugify(name), personalOwnerUserId: input.userId }),
      db.insert(membership).values({ id: newId("mem"), orgId, userId: input.userId, role: "owner" }),
      db.insert(auditEvent).values({ id: newId("aud"), orgId, actorUserId: input.userId, action: "org.created", target: orgId }),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed: org.personal_owner_user_id")) return null;
    throw error;
  }
  await postCreditTxn(db, {
    orgId,
    kind: "grant",
    amount: WELCOME_CREDITS,
    idempotencyKey: `welcome:${orgId}`,
    description: "Beta welcome credits",
  });
  return { orgId, name };
}

/**
 * Self-heal for accounts whose workspace wasn't created at sign-up (e.g. a database error
 * in the sign-up hook). Creates it only if the user has no personal workspace at all;
 * if one exists but they aren't a member, access stays denied (fail closed).
 */
export async function ensurePersonalOrg(db: Db, input: { userId: string; userName: string }) {
  const [existing] = await db.select({ id: org.id }).from(org).where(eq(org.personalOwnerUserId, input.userId));
  if (existing) return;
  await createPersonalOrg(db, input);
}

/**
 * The org a signed-in user is acting in: the requested one if they belong to it,
 * otherwise their oldest membership. Returns null when they have no access.
 */
export async function resolveMembership(
  db: Db,
  userId: string,
  requestedOrgId?: string,
): Promise<{ orgId: string; role: Role } | null> {
  const conditions = requestedOrgId
    ? and(eq(membership.userId, userId), eq(membership.orgId, requestedOrgId))
    : eq(membership.userId, userId);
  const [row] = await db
    .select({ orgId: membership.orgId, role: membership.role })
    .from(membership)
    .where(conditions)
    .orderBy(asc(membership.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getOrg(db: Db, orgId: string) {
  const [row] = await db
    .select({ id: org.id, name: org.name, slug: org.slug, plan: org.plan, fullAccess: org.fullAccess })
    .from(org)
    .where(eq(org.id, orgId));
  return row ?? null;
}

export async function recordAudit(
  db: Db,
  event: { orgId: string; actorUserId?: string | null; actorApiKeyId?: string | null; action: string; target?: string; meta?: unknown },
) {
  await db.insert(auditEvent).values({ id: newId("aud"), ...event });
}

/** The workspace's audit log, newest first, 50 per page (`before` = the last id of the previous page). */
export async function listAudit(db: Db, orgId: string, before?: string) {
  return db
    .select({ id: auditEvent.id, action: auditEvent.action, target: auditEvent.target, actorUserId: auditEvent.actorUserId, actorApiKeyId: auditEvent.actorApiKeyId, meta: auditEvent.meta, createdAt: auditEvent.createdAt })
    .from(auditEvent)
    .where(before ? and(eq(auditEvent.orgId, orgId), lt(auditEvent.id, before)) : eq(auditEvent.orgId, orgId))
    .orderBy(desc(auditEvent.id))
    .limit(50);
}
