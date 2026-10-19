// Showrium staff: who may use the admin app, with which role. Owners come from the
// PLATFORM_ADMIN_EMAILS secret (the bootstrap list); everyone else is invited here by an owner.
// Nothing is hard-deleted: removing staff sets revokedAt, and they can be invited again.
import { and, eq, isNull } from "drizzle-orm";
import { invite, staffMember, user, STAFF_ROLES, type Db, type StaffRole } from "@nextrium/db";
import { isPlatformAdmin } from "./access.js";
import { newId } from "./ids.js";
import { looksLikeEmail } from "./email.js";
import { createInvite } from "./invites.js";
import { adminAudit } from "@nextrium/db";

export { STAFF_ROLES, type StaffRole };

/** What each staff role may do in the admin app. */
export const STAFF_PERMISSIONS = {
  owner: ["overview", "waitlist", "users", "users.manage", "billing", "costs", "health", "abuse", "abuse.pause", "staff", "audit"],
  support: ["overview", "waitlist", "users", "health", "abuse"],
  finance: ["overview", "billing", "costs"],
} as const satisfies Record<StaffRole, readonly string[]>;
export type StaffPermission = (typeof STAFF_PERMISSIONS)[StaffRole][number];

export const staffCan = (role: StaffRole | null | undefined, permission: StaffPermission) => Boolean(role && (STAFF_PERMISSIONS[role] as readonly string[]).includes(permission));

export class StaffError extends Error {
  constructor(
    readonly code: "forbidden" | "exists" | "not_found" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "StaffError";
  }
}

const norm = (email: string) => email.trim().toLowerCase();

/** Staff changes go to the admin action log (by the actor's verified email). */
const log = (db: Db, actorEmail: string, action: string, target: string, meta?: Record<string, unknown>) =>
  db.insert(adminAudit).values({ id: newId("adm"), actorEmail, action, target, meta: meta ?? null });

/**
 * The staff role of a signed-in person, or null. Owners on the secret list need no row.
 * Invited staff must have a verified email (so nobody can claim a staff address they don't own).
 */
export async function staffRoleFor(db: Db, who: { userId: string; email: string }, ownerList: string | undefined): Promise<StaffRole | null> {
  if (isPlatformAdmin(who.email, ownerList)) return "owner";
  const [row] = await db
    .select({ id: staffMember.id, role: staffMember.role, acceptedAt: staffMember.acceptedAt, verified: user.emailVerified })
    .from(staffMember)
    .innerJoin(user, eq(user.id, who.userId))
    .where(and(eq(staffMember.email, norm(who.email)), isNull(staffMember.revokedAt)));
  if (!row?.verified) return null;
  if (!row.acceptedAt) await db.update(staffMember).set({ acceptedAt: new Date() }).where(eq(staffMember.id, row.id));
  return row.role;
}

export async function listStaff(db: Db, ownerList: string | undefined) {
  const rows = await db.select().from(staffMember).where(isNull(staffMember.revokedAt));
  const owners = (ownerList ?? "")
    .split(",")
    .map(norm)
    .filter((e) => e.includes("@") && !e.startsWith("@"));
  return [
    ...owners.map((email) => ({ id: null as string | null, email, role: "owner" as StaffRole, fromSettings: true, acceptedAt: null as Date | null, createdAt: null as Date | null })),
    ...rows.filter((r) => !owners.includes(r.email)).map((r) => ({ id: r.id as string | null, email: r.email, role: r.role, fromSettings: false, acceptedAt: r.acceptedAt, createdAt: r.createdAt as Date | null })),
  ];
}

/**
 * Owners invite staff. If the person has no account yet, a single-use account invite is created too
 * (sign-up is otherwise closed); the caller emails the link. Returns the token only when one was made.
 */
export async function inviteStaff(db: Db, input: { email: string; role: StaffRole; actor: { email: string; userId?: string | null | undefined; role: StaffRole | null } }) {
  if (input.actor.role !== "owner") throw new StaffError("forbidden", "Only owners can invite staff.");
  const email = norm(input.email);
  if (!looksLikeEmail(email)) throw new StaffError("invalid", "Enter a valid email address.");
  if (!STAFF_ROLES.includes(input.role)) throw new StaffError("invalid", "Choose a role.");
  const [existing] = await db.select().from(staffMember).where(eq(staffMember.email, email));
  if (existing && !existing.revokedAt) throw new StaffError("exists", "That person is already staff.");
  const [account] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  const created = account ? null : await createInvite(db, { createdByUserId: input.actor.userId ?? null, note: `Staff: ${email}` });
  const values = { role: input.role, invitedByUserId: input.actor.userId ?? null, inviteId: created?.id ?? null, acceptedAt: null, revokedAt: null };
  if (existing) await db.update(staffMember).set(values).where(eq(staffMember.id, existing.id));
  else await db.insert(staffMember).values({ id: newId("stf"), email, ...values });
  await log(db, input.actor.email, "staff.invited", email, { role: input.role });
  return { email, role: input.role, token: created?.token ?? null, hasAccount: Boolean(account) };
}

/** Changes a role, or removes someone (soft). Owners from the settings list can't be changed here, nor can you change yourself. */
export async function updateStaff(db: Db, input: { id: string; role?: StaffRole | undefined; remove?: boolean | undefined; actor: { email: string; role: StaffRole | null } }) {
  if (input.actor.role !== "owner") throw new StaffError("forbidden", "Only owners can change staff.");
  const [row] = await db.select().from(staffMember).where(eq(staffMember.id, input.id));
  if (!row || row.revokedAt) throw new StaffError("not_found", "No such staff member.");
  if (row.email === norm(input.actor.email)) throw new StaffError("forbidden", "You can't change your own access.");
  if (input.remove) {
    await db.update(staffMember).set({ revokedAt: new Date() }).where(eq(staffMember.id, row.id));
    // An unused account invite sent with it stops working too.
    if (row.inviteId) await db.update(invite).set({ revokedAt: new Date() }).where(and(eq(invite.id, row.inviteId), isNull(invite.acceptedAt), isNull(invite.revokedAt)));
    await log(db, input.actor.email, "staff.removed", row.email);
    return;
  }
  if (input.role && STAFF_ROLES.includes(input.role)) {
    await db.update(staffMember).set({ role: input.role }).where(eq(staffMember.id, row.id));
    await log(db, input.actor.email, "staff.role_changed", row.email, { role: input.role });
  }
}
