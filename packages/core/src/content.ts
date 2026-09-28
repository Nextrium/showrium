// Persona, context items, drafts and the compose pipeline. Every function takes orgId and
// filters by it: tenant isolation lives here, never in the caller.
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  brief,
  contextItem,
  draft,
  org,
  persona,
  source,
  type ContentMode,
  type Db,
  type DraftStatus,
  type Platform,
} from "@nextrium/db";
import {
  checkVariants,
  ComposeSchema,
  composeSystemPrompt,
  composeUserPrompt,
  generateStructured,
  repairUserPrompt,
  RepairSchema,
  type Provider,
} from "@nextrium/llm";
import { checkFacts, hasErrors, lintPost, type LintIssue } from "@nextrium/policy";
import { getBalance, InsufficientCreditsError, postCreditTxn } from "./credits.js";
import { chunkRows } from "./chunk.js";
import { newId } from "./ids.js";
import { recordAudit } from "./orgs.js";
import type { IngestedItem } from "./ingest.js";
import { addUsage, CREDITS_PER_EXTRA_POST, getUsage, PLAN_LIMITS, type Plan } from "./plans.js";

// --- Persona ----------------------------------------------------------------

export type PersonaData = Omit<typeof persona.$inferInsert, "orgId" | "updatedAt">;

export async function getPersona(db: Db, orgId: string) {
  const [row] = await db.select().from(persona).where(eq(persona.orgId, orgId));
  return row ?? null;
}

export async function savePersona(db: Db, orgId: string, data: PersonaData) {
  await db
    .insert(persona)
    .values({ ...data, orgId })
    .onConflictDoUpdate({ target: persona.orgId, set: { ...data, updatedAt: new Date() } });
  return getPersona(db, orgId);
}

// --- Context items ----------------------------------------------------------

export async function addContextItems(
  db: Db,
  orgId: string,
  kind: (typeof contextItem.$inferInsert)["kind"],
  items: IngestedItem[],
  sourceId: string | null = null,
) {
  if (!items.length) return [];
  const rows = items.map((i) => ({ id: newId("ctx"), orgId, sourceId, kind, title: i.title, body: i.body, url: i.url, externalId: i.externalId }));
  // Items already seen from a source (same externalId) are skipped, not duplicated.
  const added: { id: string; title: string }[] = [];
  for (const part of chunkRows(rows, 8)) {
    added.push(...(await db.insert(contextItem).values(part).onConflictDoNothing({ target: [contextItem.orgId, contextItem.externalId] }).returning({ id: contextItem.id, title: contextItem.title })));
  }
  return added;
}

export async function listContextItems(db: Db, orgId: string, limit = 50) {
  return db
    .select({ id: contextItem.id, kind: contextItem.kind, title: contextItem.title, body: contextItem.body, url: contextItem.url, createdAt: contextItem.createdAt })
    .from(contextItem)
    .where(eq(contextItem.orgId, orgId))
    .orderBy(desc(contextItem.createdAt))
    .limit(limit);
}

// --- Sources ----------------------------------------------------------------

export class SourceLimitError extends Error {
  constructor(limit: number) {
    super(`Your plan allows ${limit} connected source${limit === 1 ? "" : "s"}. Remove one or upgrade.`);
    this.name = "SourceLimitError";
  }
}

export async function addSource(db: Db, orgId: string, plan: Plan, kind: "github_repo" | "rss", key: string) {
  const existing = await db.select({ id: source.id }).from(source).where(eq(source.orgId, orgId));
  if (existing.length >= PLAN_LIMITS[plan].sources) throw new SourceLimitError(PLAN_LIMITS[plan].sources);
  const [row] = await db
    .insert(source)
    .values({ id: newId("src"), orgId, kind, key })
    .onConflictDoNothing({ target: [source.orgId, source.kind, source.key] })
    .returning();
  return row ?? null;
}

export async function listSources(db: Db, orgId: string) {
  return db.select().from(source).where(eq(source.orgId, orgId)).orderBy(desc(source.createdAt));
}

export async function getSource(db: Db, orgId: string, id: string) {
  const [row] = await db.select().from(source).where(and(eq(source.orgId, orgId), eq(source.id, id)));
  return row ?? null;
}

export async function removeSource(db: Db, orgId: string, id: string) {
  const removed = await db.delete(source).where(and(eq(source.orgId, orgId), eq(source.id, id))).returning({ id: source.id });
  return removed.length > 0;
}

export async function markSourceChecked(db: Db, orgId: string, id: string, error: string | null) {
  await db.update(source).set({ lastCheckedAt: new Date(), lastError: error }).where(and(eq(source.orgId, orgId), eq(source.id, id)));
}

// --- Compose ----------------------------------------------------------------

export class ComposeError extends Error {
  constructor(
    readonly code: "persona_required" | "context_not_found" | "no_platforms" | "quota_exceeded" | "ai_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ComposeError";
  }
}

/** The plan that applies: the paid plan, or the staff tier when a platform admin granted full access. */
export async function getOrgPlan(db: Db, orgId: string): Promise<Plan> {
  const [row] = await db.select({ plan: org.plan, fullAccess: org.fullAccess }).from(org).where(eq(org.id, orgId));
  if (row?.fullAccess) return "staff";
  return (row?.plan ?? "free") as Plan;
}

/** Platform admins only (checked by the caller): grant or remove full access for a workspace. Audited. */
export async function setFullAccess(db: Db, orgId: string, input: { full: boolean; note: string; actorUserId: string }) {
  const [row] = await db
    .update(org)
    .set(input.full ? { fullAccess: true, fullAccessNote: input.note, fullAccessBy: input.actorUserId, fullAccessAt: new Date() } : { fullAccess: false, fullAccessNote: null, fullAccessBy: null, fullAccessAt: null })
    .where(eq(org.id, orgId))
    .returning({ id: org.id });
  if (row) await recordAudit(db, { orgId, actorUserId: input.actorUserId, action: input.full ? "access.granted" : "access.removed", target: orgId, meta: { note: input.note } });
  return Boolean(row);
}

export async function listFullAccess(db: Db) {
  return db.select({ id: org.id, name: org.name, note: org.fullAccessNote, at: org.fullAccessAt }).from(org).where(eq(org.fullAccess, true)).orderBy(desc(org.fullAccessAt)).limit(200);
}

export async function compose(
  db: Db,
  providers: Provider[],
  input: { orgId: string; contextItemId: string; mode: ContentMode; platforms: Platform[] },
) {
  const platforms = [...new Set(input.platforms)];
  if (!platforms.length) throw new ComposeError("no_platforms", "Choose at least one platform.");
  const who = await getPersona(db, input.orgId);
  if (!who) throw new ComposeError("persona_required", "Set up your voice first, so posts sound like you.");
  const [ctx] = await db
    .select()
    .from(contextItem)
    .where(and(eq(contextItem.orgId, input.orgId), eq(contextItem.id, input.contextItemId)));
  if (!ctx) throw new ComposeError("context_not_found", "That item wasn't found in your workspace.");

  // Quota pre-check: posts left this month plus credits must cover the request.
  const plan = await getOrgPlan(db, input.orgId);
  const used = (await getUsage(db, input.orgId)).postsGenerated;
  const left = Math.max(0, PLAN_LIMITS[plan].posts - used);
  if (left < platforms.length && (await getBalance(db, input.orgId)) < (platforms.length - left) * CREDITS_PER_EXTRA_POST) {
    throw new ComposeError("quota_exceeded", `You've used this month's ${PLAN_LIMITS[plan].posts} posts and don't have enough credits for ${platforms.length} more.`);
  }

  const system = composeSystemPrompt(who);
  let result;
  try {
    result = await generateStructured(
      providers,
      { system, user: composeUserPrompt({ mode: input.mode, platforms, contextTitle: ctx.title, contextBody: ctx.body }), maxTokens: 6000 },
      ComposeSchema,
      (out) => checkVariants(out, platforms),
    );
  } catch (error) {
    console.error("compose failed", error);
    throw new ComposeError("ai_unavailable", "The writing engine is busy right now. Please try again in a minute.");
  }

  let cost = result.costMicroUsd;
  const variants: { platform: Platform; text: string; issues: LintIssue[] }[] = [];
  for (const v of result.data.variants.filter((x) => platforms.includes(x.platform))) {
    let text = v.text.trim();
    let issues = lintPost(v.platform, text);
    // One repair attempt for hard errors (too long, placeholders); otherwise keep and show the issue.
    if (hasErrors(issues)) {
      try {
        const fixed = await generateStructured(
          providers,
          { system, user: repairUserPrompt(v.platform, text, issues.filter((i) => i.severity === "error").map((i) => i.message).join(" ")), maxTokens: 2000 },
          RepairSchema,
        );
        cost += fixed.costMicroUsd;
        const fixedIssues = lintPost(v.platform, fixed.data.text.trim());
        if (!hasErrors(fixedIssues)) {
          text = fixed.data.text.trim();
          issues = fixedIssues;
        }
      } catch {
        // Keep the original; the error stays visible to the user.
      }
    }
    variants.push({ platform: v.platform, text, issues: [...issues, ...checkFacts(text, `${ctx.title}
${ctx.body}`)] });
  }

  const briefId = newId("brf");
  const rows = variants.map((v) => ({ id: newId("drf"), orgId: input.orgId, briefId, platform: v.platform, text: v.text, issues: v.issues }));
  await db.batch([
    db.insert(brief).values({
      id: briefId,
      orgId: input.orgId,
      contextItemId: ctx.id,
      mode: input.mode,
      angle: result.data.angle,
      keyPoints: result.data.key_points,
      model: result.model,
      costMicroUsd: cost,
    }),
    db.insert(draft).values(rows),
  ]);

  // Charge usage after success. A concurrent request can push slightly past the limit;
  // the extra is billed in credits when available (cost per post is ~$0.00003).
  const { overage } = await addUsage(db, input.orgId, "postsGenerated", rows.length, PLAN_LIMITS[plan].posts);
  if (overage > 0) {
    try {
      await postCreditTxn(db, { orgId: input.orgId, kind: "spend", amount: -overage * CREDITS_PER_EXTRA_POST, idempotencyKey: `compose:${briefId}`, description: `${overage} extra post${overage === 1 ? "" : "s"}` });
    } catch (error) {
      if (!(error instanceof InsufficientCreditsError)) throw error;
      console.warn("overage without credits after concurrent compose", { orgId: input.orgId, overage });
    }
  }

  return { briefId, model: result.model, angle: result.data.angle, drafts: await listDrafts(db, input.orgId, { briefId }) };
}

// --- Drafts -----------------------------------------------------------------

export async function listDrafts(db: Db, orgId: string, filter: { status?: DraftStatus; briefId?: string } = {}) {
  const conditions = [eq(draft.orgId, orgId)];
  if (filter.status) conditions.push(eq(draft.status, filter.status));
  if (filter.briefId) conditions.push(eq(draft.briefId, filter.briefId));
  return db.select().from(draft).where(and(...conditions)).orderBy(desc(draft.createdAt)).limit(200);
}

export async function getDraft(db: Db, orgId: string, id: string) {
  const [row] = await db.select().from(draft).where(and(eq(draft.orgId, orgId), eq(draft.id, id)));
  return row ?? null;
}

/** Status changes a user may make directly. Publishing states are set by the publisher. */
const USER_TRANSITIONS: Partial<Record<DraftStatus, DraftStatus[]>> = {
  draft: ["approved", "discarded"],
  approved: ["draft", "discarded"],
  failed: ["draft", "discarded"],
  discarded: ["draft"],
  scheduled: ["approved", "discarded"],
};

export class DraftStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftStateError";
  }
}

export async function updateDraft(db: Db, orgId: string, id: string, patch: { text?: string; status?: DraftStatus }) {
  const current = await getDraft(db, orgId, id);
  if (!current) return null;
  if (current.status === "published" || current.status === "publishing") throw new DraftStateError("Published posts can't be edited here.");
  const set: Partial<typeof draft.$inferInsert> = { updatedAt: new Date() };
  if (patch.text !== undefined) {
    set.text = patch.text;
    set.issues = lintPost(current.platform, patch.text);
    set.aiGenerated = true; // Still AI-assisted even after human edits.
  }
  if (patch.status && patch.status !== current.status) {
    if (!USER_TRANSITIONS[current.status]?.includes(patch.status)) {
      throw new DraftStateError(`A ${current.status} post can't be moved to ${patch.status}.`);
    }
    const issues = set.issues ?? current.issues;
    if (patch.status === "approved" && issues.some((i) => i.severity === "error")) {
      throw new DraftStateError("Fix the errors on this post before approving it.");
    }
    set.status = patch.status;
    if (patch.status !== "scheduled") set.scheduledAt = null;
  }
  // Guard against concurrent edits changing a post that just started publishing.
  await db
    .update(draft)
    .set(set)
    .where(and(eq(draft.orgId, orgId), eq(draft.id, id), inArray(draft.status, ["draft", "approved", "failed", "discarded", "scheduled"])));
  return getDraft(db, orgId, id);
}
