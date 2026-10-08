// Workspace members: invitations bound to one email address, role changes and removal.
// Rules: only owners make or remove owners; a workspace always keeps at least one owner;
// seats are limited by plan (members + pending invites).
import { and, asc, count, eq, gt, isNull } from "drizzle-orm";
import { apiKey, membership, org, teamInvite, user, type Db, type Role } from "@nextrium/db";
import { hashApiKey as sha256Hex } from "./api-keys.js";
import { getOrgLimits, getOrgPlan } from "./content.js";
import { newId } from "./ids.js";
import { recordAudit } from "./orgs.js";
import { PLAN_FEATURES } from "./plans.js";

const TOKEN_PREFIX = "tmi_";
export const TEAM_INVITE_TTL_MS = 7 * 86_400_000;

export class TeamError extends Error {
  constructor(
    readonly code: "seats" | "exists" | "not_found" | "forbidden" | "last_owner" | "invalid_invite" | "wrong_email",
    message: string,
  ) {
    super(message);
    this.name = "TeamError";
  }
}

export function looksLikeTeamInviteToken(token: string | null | undefined): token is string {
  return typeof token === "string" && token.startsWith(TOKEN_PREFIX) && token.length >= 40 && token.length <= 100;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return TOKEN_PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function listMembers(db: Db, orgId: string) {
  const members = await db
    .select({ id: membership.id, userId: membership.userId, role: membership.role, name: user.name, email: user.email, createdAt: membership.createdAt })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(membership.orgId, orgId))
    .orderBy(asc(membership.createdAt));
  const invites = await db
    .select({ id: teamInvite.id, email: teamInvite.email, role: teamInvite.role, expiresAt: teamInvite.expiresAt, createdAt: teamInvite.createdAt })
    .from(teamInvite)
    .where(and(eq(teamInvite.orgId, orgId), isNull(teamInvite.acceptedAt), isNull(teamInvite.revokedAt), gt(teamInvite.expiresAt, new Date())))
    .orderBy(asc(teamInvite.createdAt));
  return { members, invites };
}

/** Workspaces the user belongs to (for the switcher). */
export async function listWorkspaces(db: Db, userId: string) {
  return db
    .select({ id: org.id, name: org.name, plan: org.plan, fullAccess: org.fullAccess, role: membership.role, personal: org.personalOwnerUserId })
    .from(membership)
    .innerJoin(org, eq(org.id, membership.orgId))
    .where(eq(membership.userId, userId))
    .orderBy(asc(membership.createdAt));
}

export async function inviteMember(db: Db, input: { orgId: string; email: string; role: Role; actor: { userId: string; role: Role } }, now = Date.now()) {
  const email = input.email.trim().toLowerCase();
  if (input.role === "owner" && input.actor.role !== "owner") throw new TeamError("forbidden", "Only owners can invite owners.");
  const { members, invites } = await listMembers(db, input.orgId);
  if (members.some((m) => m.email.toLowerCase() === email)) throw new TeamError("exists", "That person is already a member.");
  if (invites.some((i) => i.email === email)) throw new TeamError("exists", "That person already has an invitation. Revoke it to send a new one.");
  // Members and open invitations both hold a seat. Seats are paid for the whole period, so a removed
  // member's seat can go to someone new, but usage this month isn't reset.
  const { plan, seats } = await getOrgLimits(db, input.orgId);
  if (members.length + invites.length >= seats) {
    throw new TeamError(
      "seats",
      plan === "team_seats"
        ? `Your Team plan is paid for ${seats} members. Add a member to your plan in Billing first.`
        : plan === "team" || plan === "staff"
          ? `Your plan includes ${seats} members.`
          : "Only one person per plan. Switch to a Team plan in Billing to add teammates.",
    );
  }
  const token = randomToken();
  const row = { id: newId("tmi"), orgId: input.orgId, email, role: input.role, tokenHash: await sha256Hex(token), invitedByUserId: input.actor.userId, expiresAt: new Date(now + TEAM_INVITE_TTL_MS) };
  await db.insert(teamInvite).values(row);
  await recordAudit(db, { orgId: input.orgId, actorUserId: input.actor.userId, action: "member.invited", target: row.id, meta: { role: input.role } });
  return { id: row.id, token, expiresAt: row.expiresAt };
}

async function findUsableInvite(db: Db, token: string, now = Date.now()) {
  if (!looksLikeTeamInviteToken(token)) return null;
  const [row] = await db
    .select({ id: teamInvite.id, orgId: teamInvite.orgId, email: teamInvite.email, role: teamInvite.role, orgName: org.name })
    .from(teamInvite)
    .innerJoin(org, eq(org.id, teamInvite.orgId))
    .where(and(eq(teamInvite.tokenHash, await sha256Hex(token)), isNull(teamInvite.acceptedAt), isNull(teamInvite.revokedAt), gt(teamInvite.expiresAt, new Date(now))));
  return row ?? null;
}

/** Public preview for the join page: which workspace, and a hint of the email it's for. */
export async function previewTeamInvite(db: Db, token: string) {
  const row = await findUsableInvite(db, token);
  if (!row) return null;
  const [name, domain] = row.email.split("@");
  return { workspace: row.orgName, role: row.role, emailHint: `${name!.slice(0, 2)}…@${domain}` };
}

/** True when a not-yet-registered person may create an account because they hold an invite for this email. */
export async function teamInviteAllowsSignUp(db: Db, token: string | null, email: string) {
  if (!token) return false;
  const row = await findUsableInvite(db, token);
  return Boolean(row && row.email === email.trim().toLowerCase());
}

export async function acceptTeamInvite(db: Db, token: string, who: { userId: string; email: string; emailVerified: boolean }) {
  const row = await findUsableInvite(db, token);
  if (!row) throw new TeamError("invalid_invite", "This invitation is invalid, already used or expired.");
  if (!who.emailVerified || row.email !== who.email.trim().toLowerCase()) {
    throw new TeamError("wrong_email", "This invitation is for a different email address. Sign in with the invited email.");
  }
  // Claim the invite first, so it can be used only once.
  const [claimed] = await db
    .update(teamInvite)
    .set({ acceptedAt: new Date(), acceptedByUserId: who.userId })
    .where(and(eq(teamInvite.id, row.id), isNull(teamInvite.acceptedAt), isNull(teamInvite.revokedAt)))
    .returning({ id: teamInvite.id });
  if (!claimed) throw new TeamError("invalid_invite", "This invitation was just used.");
  await db.insert(membership).values({ id: newId("mem"), orgId: row.orgId, userId: who.userId, role: row.role }).onConflictDoNothing();
  await recordAudit(db, { orgId: row.orgId, actorUserId: who.userId, action: "member.joined", target: who.userId, meta: { role: row.role } });
  return { orgId: row.orgId, workspace: row.orgName };
}

export async function revokeTeamInvite(db: Db, orgId: string, id: string, actorUserId: string) {
  const rows = await db
    .update(teamInvite)
    .set({ revokedAt: new Date() })
    .where(and(eq(teamInvite.orgId, orgId), eq(teamInvite.id, id), isNull(teamInvite.acceptedAt), isNull(teamInvite.revokedAt)))
    .returning({ id: teamInvite.id });
  if (rows.length) await recordAudit(db, { orgId, actorUserId, action: "member.invite_revoked", target: id });
  return rows.length > 0;
}

/** API keys act as admin; keys made by someone who is no longer an admin (or no longer a member) stop working. */
async function revokeKeysCreatedBy(db: Db, orgId: string, userId: string) {
  const revoked = await db
    .update(apiKey)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKey.orgId, orgId), eq(apiKey.createdByUserId, userId), isNull(apiKey.revokedAt)))
    .returning({ id: apiKey.id });
  return revoked.length;
}

async function ownerCount(db: Db, orgId: string) {
  const [row] = await db.select({ n: count() }).from(membership).where(and(eq(membership.orgId, orgId), eq(membership.role, "owner")));
  return row?.n ?? 0;
}

export async function changeMemberRole(db: Db, input: { orgId: string; memberId: string; role: Role; actor: { userId: string; role: Role } }) {
  const [m] = await db.select().from(membership).where(and(eq(membership.orgId, input.orgId), eq(membership.id, input.memberId)));
  if (!m) throw new TeamError("not_found", "No such member.");
  if ((m.role === "owner" || input.role === "owner") && input.actor.role !== "owner") throw new TeamError("forbidden", "Only owners can make or change owners.");
  if (m.role === "owner" && input.role !== "owner" && (await ownerCount(db, input.orgId)) <= 1) throw new TeamError("last_owner", "A workspace needs at least one owner.");
  await db.update(membership).set({ role: input.role }).where(eq(membership.id, m.id));
  const keysRevoked = input.role === "owner" || input.role === "admin" ? 0 : await revokeKeysCreatedBy(db, input.orgId, m.userId);
  await recordAudit(db, { orgId: input.orgId, actorUserId: input.actor.userId, action: "member.role_changed", target: m.userId, meta: { from: m.role, to: input.role, keysRevoked } });
}

/** Removes a member (owners and admins), or lets a member leave (themselves). */
export async function removeMember(db: Db, input: { orgId: string; memberId: string; actor: { userId: string; role: Role } }) {
  const [m] = await db.select().from(membership).where(and(eq(membership.orgId, input.orgId), eq(membership.id, input.memberId)));
  if (!m) throw new TeamError("not_found", "No such member.");
  const self = m.userId === input.actor.userId;
  if (!self && input.actor.role !== "owner" && input.actor.role !== "admin") throw new TeamError("forbidden", "Only owners and admins can remove members.");
  if (!self && m.role === "owner" && input.actor.role !== "owner") throw new TeamError("forbidden", "Only owners can remove owners.");
  if (m.role === "owner" && (await ownerCount(db, input.orgId)) <= 1) throw new TeamError("last_owner", "A workspace needs at least one owner.");
  const [ws] = await db.select({ personal: org.personalOwnerUserId }).from(org).where(eq(org.id, input.orgId));
  if (ws?.personal === m.userId) throw new TeamError("forbidden", "The owner of a personal workspace can't be removed from it.");
  await db.delete(membership).where(eq(membership.id, m.id));
  const keysRevoked = await revokeKeysCreatedBy(db, input.orgId, m.userId);
  await recordAudit(db, { orgId: input.orgId, actorUserId: input.actor.userId, action: self ? "member.left" : "member.removed", target: m.userId, meta: { keysRevoked } });
}

export async function getUserIdentity(db: Db, userId: string) {
  const [row] = await db.select({ email: user.email, emailVerified: user.emailVerified }).from(user).where(eq(user.id, userId));
  return row ?? null;
}

export async function findUserIdByEmail(db: Db, email: string) {
  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email.trim().toLowerCase()));
  return row?.id ?? null;
}
