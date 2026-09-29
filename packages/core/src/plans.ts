// Plan limits (from cost-model-and-pricing.md). Over the limit, each extra post costs 1 credit.
import { and, eq, sql } from "drizzle-orm";
import { usageCounter, type Db } from "@nextrium/db";

export const PLAN_LIMITS = {
  free: { posts: 20, xApiPosts: 0, videos: 2, sources: 1, uploadsPerDay: 3 },
  lite: { posts: 60, xApiPosts: 0, videos: 5, sources: 1, uploadsPerDay: 8 },
  starter: { posts: 150, xApiPosts: 15, videos: 15, sources: 2, uploadsPerDay: 15 },
  creator: { posts: 400, xApiPosts: 50, videos: 40, sources: 5, uploadsPerDay: 30 },
  pro: { posts: 600, xApiPosts: 100, videos: 60, sources: 15, uploadsPerDay: 50 },
  team: { posts: 2000, xApiPosts: 300, videos: 150, sources: 50, uploadsPerDay: 50 },
  // Full access granted by a platform admin. Still capped: AI and X posts cost real money.
  staff: { posts: 5000, xApiPosts: 300, videos: 500, sources: 50, uploadsPerDay: 200 },
} as const;
export type Plan = keyof typeof PLAN_LIMITS;
export const CREDITS_PER_EXTRA_POST = 1;
export const CREDITS_PER_X_API_POST = 2;
/** Photos and documents beyond the plan's daily uploads (reading an image costs real money). */
export const CREDITS_PER_EXTRA_UPLOAD = 2;
export const CREDITS_PER_X_API_POST_WITH_LINK = 25;

export function currentPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export async function getUsage(db: Db, orgId: string, period = currentPeriod()) {
  const [row] = await db.select().from(usageCounter).where(and(eq(usageCounter.orgId, orgId), eq(usageCounter.period, period)));
  return { postsGenerated: row?.postsGenerated ?? 0, videosRendered: row?.videosRendered ?? 0, xApiPosts: row?.xApiPosts ?? 0 };
}

/**
 * Records usage for this period. Returns how many of `n` were beyond the plan (to be paid in credits).
 * The counter always records the true total, so overage is visible even under concurrent requests.
 */
export async function addUsage(
  db: Db,
  orgId: string,
  field: "postsGenerated" | "videosRendered" | "xApiPosts",
  n: number,
  limit: number,
  period = currentPeriod(),
): Promise<{ overage: number; total: number }> {
  const column = { postsGenerated: usageCounter.postsGenerated, videosRendered: usageCounter.videosRendered, xApiPosts: usageCounter.xApiPosts }[field];
  const [row] = await db
    .insert(usageCounter)
    .values({ orgId, period, [field]: n })
    .onConflictDoUpdate({ target: [usageCounter.orgId, usageCounter.period], set: { [field]: sql`${column} + ${n}` } })
    .returning({ total: column });
  const total = row?.total ?? n;
  const before = total - n;
  const overage = Math.max(0, total - Math.max(limit, before));
  return { overage: Math.min(n, overage), total };
}

/**
 * Features per plan (cost-model-and-pricing.md, section 3). Quotas are in PLAN_LIMITS.
 * autopilot: the highest autopilot level allowed. insights: AI audience themes. seats: members per workspace.
 */
export const PLAN_FEATURES = {
  free: { autopilot: "coach", insights: false, seats: 1 },
  lite: { autopilot: "coach", insights: false, seats: 1 },
  starter: { autopilot: "batch", insights: true, seats: 1 },
  creator: { autopilot: "autopilot", insights: true, seats: 1 },
  pro: { autopilot: "autopilot", insights: true, seats: 3 },
  team: { autopilot: "autopilot", insights: true, seats: 25 },
  staff: { autopilot: "autopilot", insights: true, seats: 50 },
} as const satisfies Record<Plan, { autopilot: "coach" | "batch" | "autopilot"; insights: boolean; seats: number }>;

const LEVEL_ORDER = ["coach", "drafts", "batch", "autopilot"] as const;
/** The level actually used: the chosen one, capped by what the plan allows. */
export function allowedAutopilotLevel(plan: Plan, wanted: (typeof LEVEL_ORDER)[number]): (typeof LEVEL_ORDER)[number] {
  const max = LEVEL_ORDER.indexOf(PLAN_FEATURES[plan].autopilot);
  return LEVEL_ORDER[Math.min(LEVEL_ORDER.indexOf(wanted), max)]!;
}
