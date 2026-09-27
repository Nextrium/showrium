import { and, asc, eq } from "drizzle-orm";
import { auditEvent, membership, org, type Db, type Role } from "@nextrium/db";
import { postCreditTxn } from "./credits.js";
import { newId } from "./ids.js";

/** Credits every new workspace starts with during the beta (1 credit = $0.01). */
export const WELCOME_CREDITS = 20;

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "workspace";
  return `${base}-${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36).slice(0, 5)}`;
}

/** Creates the user's first workspace, makes them owner, and grants the welcome credits. */
export async function createPersonalOrg(db: Db, input: { userId: string; userName: string }) {
  const orgId = newId("org");
  const name = `${input.userName.split(" ")[0] || "My"}'s workspace`;
  await db.batch([
    db.insert(org).values({ id: orgId, name, slug: slugify(name) }),
    db.insert(membership).values({ id: newId("mem"), orgId, userId: input.userId, role: "owner" }),
    db.insert(auditEvent).values({ id: newId("aud"), orgId, actorUserId: input.userId, action: "org.created", target: orgId }),
  ]);
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
    .select({ id: org.id, name: org.name, slug: org.slug, plan: org.plan })
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
