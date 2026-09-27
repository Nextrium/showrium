// Video projects: the AI plans a timeline; the browser renders it (no server render cost).
import { and, desc, eq } from "drizzle-orm";
import { contextItem, draft, videoProject, type Db, type VideoTimeline } from "@nextrium/db";
import { checkTimeline, generateStructured, TimelineSchema, videoRevisePrompt, videoSystemPrompt, videoUserPrompt, type Provider } from "@nextrium/llm";
import { getBalance, postCreditTxn } from "./credits.js";
import { getOrgPlan, getPersona } from "./content.js";
import { newId } from "./ids.js";
import { addUsage, getUsage, PLAN_LIMITS } from "./plans.js";

export const CREDITS_PER_EXTRA_VIDEO = 2;
export const MAX_REVISIONS = 20;

export class VideoError extends Error {
  constructor(
    readonly code: "not_found" | "quota_exceeded" | "ai_unavailable" | "revision_limit" | "persona_required",
    message: string,
  ) {
    super(message);
    this.name = "VideoError";
  }
}

export async function createVideo(db: Db, providers: Provider[], input: { orgId: string; aspect: VideoTimeline["aspect"]; draftId?: string | undefined; contextItemId?: string | undefined }) {
  const who = await getPersona(db, input.orgId);
  if (!who) throw new VideoError("persona_required", "Set up your voice first.");
  let material = "";
  if (input.draftId) {
    const [d] = await db.select({ text: draft.text }).from(draft).where(and(eq(draft.orgId, input.orgId), eq(draft.id, input.draftId)));
    if (!d) throw new VideoError("not_found", "That post wasn't found in your workspace.");
    material = d.text;
  } else if (input.contextItemId) {
    const [c] = await db.select({ title: contextItem.title, body: contextItem.body }).from(contextItem).where(and(eq(contextItem.orgId, input.orgId), eq(contextItem.id, input.contextItemId)));
    if (!c) throw new VideoError("not_found", "That item wasn't found in your workspace.");
    material = `${c.title}\n${c.body}`;
  } else {
    throw new VideoError("not_found", "Choose a post or some material for the video.");
  }

  const plan = await getOrgPlan(db, input.orgId);
  const used = (await getUsage(db, input.orgId)).videosRendered;
  const overQuota = used >= PLAN_LIMITS[plan].videos;
  if (overQuota && (await getBalance(db, input.orgId)) < CREDITS_PER_EXTRA_VIDEO) {
    throw new VideoError("quota_exceeded", `You've used this month's ${PLAN_LIMITS[plan].videos} videos and need ${CREDITS_PER_EXTRA_VIDEO} credits for another.`);
  }

  let result;
  try {
    result = await generateStructured(
      providers,
      { system: videoSystemPrompt(`The user: ${who.displayName}${who.role ? `, ${who.role}` : ""}. Voice: ${who.voice || "warm, plain"}.`), user: videoUserPrompt({ aspect: input.aspect, material: material.slice(0, 8000) }), maxTokens: 3000 },
      TimelineSchema,
      checkTimeline,
    );
  } catch {
    throw new VideoError("ai_unavailable", "The video planner is busy. Please try again in a minute.");
  }
  const id = newId("vid");
  const timeline = { ...result.data, aspect: input.aspect } as VideoTimeline;
  await db.insert(videoProject).values({ id, orgId: input.orgId, draftId: input.draftId ?? null, contextItemId: input.contextItemId ?? null, timeline, model: result.model });
  const { overage } = await addUsage(db, input.orgId, "videosRendered", 1, PLAN_LIMITS[plan].videos);
  if (overage > 0) {
    await postCreditTxn(db, { orgId: input.orgId, kind: "spend", amount: -CREDITS_PER_EXTRA_VIDEO, idempotencyKey: `video:${id}`, description: "Extra video" }).catch(() => undefined);
  }
  return { id, timeline, model: result.model };
}

/** Edit by chat: the agent rewrites the plan from an instruction. Free (no quota), capped per video. */
export async function reviseVideo(db: Db, providers: Provider[], input: { orgId: string; id: string; instruction: string }) {
  const [row] = await db.select().from(videoProject).where(and(eq(videoProject.orgId, input.orgId), eq(videoProject.id, input.id)));
  if (!row) throw new VideoError("not_found", "No such video in this workspace.");
  if (row.revisions >= MAX_REVISIONS) throw new VideoError("revision_limit", `A video can be revised up to ${MAX_REVISIONS} times. Start a new one to keep going.`);
  let result;
  try {
    result = await generateStructured(providers, { system: videoSystemPrompt(""), user: videoRevisePrompt(row.timeline as never, input.instruction), maxTokens: 3000 }, TimelineSchema, checkTimeline);
  } catch {
    throw new VideoError("ai_unavailable", "Couldn't apply that change. Try rephrasing it.");
  }
  const timeline = { ...result.data, aspect: row.timeline.aspect } as VideoTimeline;
  await db.update(videoProject).set({ timeline, revisions: row.revisions + 1, updatedAt: new Date() }).where(eq(videoProject.id, row.id));
  return { id: row.id, timeline };
}

export async function listVideos(db: Db, orgId: string) {
  return db.select().from(videoProject).where(eq(videoProject.orgId, orgId)).orderBy(desc(videoProject.createdAt)).limit(50);
}

export async function getVideo(db: Db, orgId: string, id: string) {
  const [row] = await db.select().from(videoProject).where(and(eq(videoProject.orgId, orgId), eq(videoProject.id, id)));
  return row ?? null;
}

// --- Premium video (avatar, cinematic): vendor accounts required -------------------------

export interface PremiumVideoProvider {
  name: string;
  creditsPerRequest: number;
}
/** Configured providers by kind. Empty until vendor contracts and keys exist (owner task). */
export function premiumProviders(env: { HEYGEN_API_KEY?: string | undefined; VEO_API_KEY?: string | undefined }) {
  return {
    avatar: env.HEYGEN_API_KEY ? ({ name: "heygen", creditsPerRequest: 100 } satisfies PremiumVideoProvider) : null,
    cinematic: env.VEO_API_KEY ? ({ name: "veo-3.1-lite", creditsPerRequest: 60 } satisfies PremiumVideoProvider) : null,
  };
}
