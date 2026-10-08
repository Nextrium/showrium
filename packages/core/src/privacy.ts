// Privacy rights (GDPR, Nigeria's NDPA): a copy of your data, and deleting your account.
// Deleting a workspace removes its rows (foreign keys cascade from `org`) and its stored files (R2).
import { and, eq, inArray, ne } from "drizzle-orm";
import {
  auditEvent,
  autopilot,
  contextItem,
  connection,
  draft,
  idea,
  imageSetting,
  membership,
  oauthState,
  org,
  persona,
  postImage,
  source,
  subscription,
  user,
  type Db,
} from "@nextrium/db";

export class PrivacyError extends Error {
  constructor(
    readonly code: "not_found" | "sole_owner" | "active_plan" | "confirm",
    message: string,
  ) {
    super(message);
    this.name = "PrivacyError";
  }
}

/** The storage used for a workspace's files (an R2 bucket fits). */
export interface FileStore {
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  delete(keys: string | string[]): Promise<void>;
}

/** Removes every stored file of a workspace (uploads, post images). */
export async function deleteWorkspaceFiles(store: FileStore, orgId: string) {
  let cursor: string | undefined;
  let deleted = 0;
  for (let page = 0; page < 1000; page++) {
    const res = await store.list({ prefix: `orgs/${orgId}/`, limit: 1000, ...(cursor ? { cursor } : {}) });
    if (res.objects.length) {
      await store.delete(res.objects.map((o) => o.key));
      deleted += res.objects.length;
    }
    if (!res.truncated || !res.cursor) break;
    cursor = res.cursor;
  }
  return deleted;
}

/** Everything the workspace holds about its work, as plain data. No secrets (tokens stay encrypted and out). */
export async function exportWorkspace(db: Db, orgId: string, userId: string) {
  const [o] = await db.select({ id: org.id, name: org.name, plan: org.plan, createdAt: org.createdAt }).from(org).where(eq(org.id, orgId));
  const [me] = await db.select({ id: user.id, name: user.name, email: user.email, createdAt: user.createdAt }).from(user).where(eq(user.id, userId));
  return {
    exportedAt: new Date().toISOString(),
    format: "showrium-export/1",
    you: me ?? null,
    workspace: o ?? null,
    voice: (await db.select().from(persona).where(eq(persona.orgId, orgId)))[0] ?? null,
    automation: (await db.select().from(autopilot).where(eq(autopilot.orgId, orgId)))[0] ?? null,
    imageSettings: (await db.select().from(imageSetting).where(eq(imageSetting.orgId, orgId)))[0] ?? null,
    sources: await db.select({ id: source.id, kind: source.kind, address: source.key, createdAt: source.createdAt }).from(source).where(eq(source.orgId, orgId)),
    material: await db
      .select({ id: contextItem.id, kind: contextItem.kind, title: contextItem.title, body: contextItem.body, url: contextItem.url, createdAt: contextItem.createdAt })
      .from(contextItem)
      .where(eq(contextItem.orgId, orgId)),
    ideas: await db.select({ id: idea.id, reason: idea.reason, status: idea.status, createdAt: idea.createdAt }).from(idea).where(eq(idea.orgId, orgId)),
    posts: (
      await db
        .select({ id: draft.id, briefId: draft.briefId, platform: draft.platform, status: draft.status, text: draft.text, parts: draft.parts, ownImages: draft.ownImages, scheduledAt: draft.scheduledAt, publishedAt: draft.publishedAt, externalUrl: draft.externalUrl, createdAt: draft.createdAt })
        .from(draft)
        .where(eq(draft.orgId, orgId))
    ),
    // Image descriptions and where each came from (the files themselves stay in the app).
    images: await db
      .select({ id: postImage.id, sharedByBrief: postImage.briefId, ownedByPost: postImage.draftId, position: postImage.position, source: postImage.source, alt: postImage.alt, aiGenerated: postImage.aiGenerated, sourceUrl: postImage.sourceUrl, createdAt: postImage.createdAt })
      .from(postImage)
      .where(eq(postImage.orgId, orgId)),
    connectedAccounts: await db.select({ platform: connection.platform, handle: connection.handle, status: connection.status, createdAt: connection.createdAt }).from(connection).where(eq(connection.orgId, orgId)),
    activity: await db.select({ action: auditEvent.action, target: auditEvent.target, createdAt: auditEvent.createdAt }).from(auditEvent).where(eq(auditEvent.orgId, orgId)),
  };
}

/**
 * Deletes an account. Workspaces where you're the only member are deleted with all their data and
 * files. In shared workspaces you're removed, unless you're the only owner (hand it over first).
 * A workspace with an active paid plan must cancel first, so nobody is billed for a deleted workspace.
 * Payment records are kept (tax law) without your name or email.
 */
export async function deleteAccount(db: Db, store: FileStore | undefined, input: { userId: string; confirmEmail: string }) {
  const [me] = await db.select({ id: user.id, email: user.email }).from(user).where(eq(user.id, input.userId));
  if (!me) throw new PrivacyError("not_found", "Account not found.");
  if (input.confirmEmail.trim().toLowerCase() !== me.email.toLowerCase()) throw new PrivacyError("confirm", "Type your email address exactly to confirm.");

  const mine = await db.select({ orgId: membership.orgId, role: membership.role }).from(membership).where(eq(membership.userId, me.id));
  const deleteOrgs: string[] = [];
  for (const m of mine) {
    const others = await db.select({ role: membership.role }).from(membership).where(and(eq(membership.orgId, m.orgId), ne(membership.userId, me.id)));
    if (!others.length) {
      deleteOrgs.push(m.orgId);
      continue;
    }
    if (m.role === "owner" && !others.some((o) => o.role === "owner")) {
      const [o] = await db.select({ name: org.name }).from(org).where(eq(org.id, m.orgId));
      throw new PrivacyError("sole_owner", `You're the only owner of "${o?.name ?? "a workspace"}". Make another member an owner in Team first.`);
    }
  }
  if (deleteOrgs.length) {
    const paid = await db.select({ orgId: subscription.orgId }).from(subscription).where(and(inArray(subscription.orgId, deleteOrgs), inArray(subscription.status, ["active", "past_due"])));
    if (paid.length) throw new PrivacyError("active_plan", "Cancel your paid plan in Billing first, so you aren't charged after deleting your account.");
  }

  // Files first (if this fails, nothing else is gone yet and the person can try again).
  let files = 0;
  if (store) for (const orgId of deleteOrgs) files += await deleteWorkspaceFiles(store, orgId);
  // Rows: the workspaces (everything cascades), short-lived OAuth states, then the user
  // (sessions, sign-in methods and remaining memberships cascade).
  for (const orgId of deleteOrgs) await db.delete(org).where(eq(org.id, orgId));
  await db.delete(oauthState).where(eq(oauthState.userId, me.id));
  await db.delete(user).where(eq(user.id, me.id));
  return { workspacesDeleted: deleteOrgs.length, filesDeleted: files };
}
