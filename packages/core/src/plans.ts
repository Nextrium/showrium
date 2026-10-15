// Plan limits (from cost-model-and-pricing.md). Over the limit, each extra post costs 1 credit.
import { and, eq, sql } from "drizzle-orm";
import { usageCounter, type Db } from "@nextrium/db";

export const PLAN_LIMITS = {
  free: { posts: 20, xApiPosts: 0, videos: 2, sources: 1, uploadsPerDay: 3, research: 3 },
  lite: { posts: 60, xApiPosts: 0, videos: 5, sources: 1, uploadsPerDay: 8, research: 10 },
  starter: { posts: 150, xApiPosts: 15, videos: 15, sources: 2, uploadsPerDay: 15, research: 20 },
  creator: { posts: 400, xApiPosts: 50, videos: 40, sources: 5, uploadsPerDay: 30, research: 40 },
  pro: { posts: 600, xApiPosts: 100, videos: 60, sources: 15, uploadsPerDay: 50, research: 60 },
  // Team (shared): Pro's allowance, shared by up to 5 members, at Pro's price.
  team: { posts: 600, xApiPosts: 100, videos: 60, sources: 15, uploadsPerDay: 50, research: 60 },
  // Team (per member): this allowance for EACH paid member (2-5), pooled for the workspace. See limitsFor.
  team_seats: { posts: 600, xApiPosts: 50, videos: 60, sources: 3, uploadsPerDay: 50, research: 60 },
  // Full access granted by a platform admin. Still capped: AI and X posts cost real money.
  staff: { posts: 5000, xApiPosts: 300, videos: 500, sources: 50, uploadsPerDay: 200, research: 300 },
} as const;
export type Plan = keyof typeof PLAN_LIMITS;
export const CREDITS_PER_EXTRA_POST = 1;
export const CREDITS_PER_X_API_POST = 2;
/** Photos and documents beyond the plan's daily uploads (reading an image costs real money). */
export const CREDITS_PER_EXTRA_UPLOAD = 2;
export const CREDITS_PER_X_API_POST_WITH_LINK = 25;
/** A web research beyond the plan's monthly allowance (search plus a stronger model, about $0.02). */
export const CREDITS_PER_EXTRA_RESEARCH = 3;

export function currentPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export async function getUsage(db: Db, orgId: string, period = currentPeriod()) {
  const [row] = await db.select().from(usageCounter).where(and(eq(usageCounter.orgId, orgId), eq(usageCounter.period, period)));
  return { postsGenerated: row?.postsGenerated ?? 0, videosRendered: row?.videosRendered ?? 0, xApiPosts: row?.xApiPosts ?? 0, researchRuns: row?.researchRuns ?? 0 };
}

/**
 * Records usage for this period. Returns how many of `n` were beyond the plan (to be paid in credits).
 * The counter always records the true total, so overage is visible even under concurrent requests.
 */
export async function addUsage(
  db: Db,
  orgId: string,
  field: "postsGenerated" | "videosRendered" | "xApiPosts" | "researchRuns",
  n: number,
  limit: number,
  period = currentPeriod(),
): Promise<{ overage: number; total: number }> {
  const column = { postsGenerated: usageCounter.postsGenerated, videosRendered: usageCounter.videosRendered, xApiPosts: usageCounter.xApiPosts, researchRuns: usageCounter.researchRuns }[field];
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
  // One person per plan, except the Team plans (owner decision 2026-10-08).
  pro: { autopilot: "autopilot", insights: true, seats: 1 },
  team: { autopilot: "autopilot", insights: true, seats: 5 },
  // The most a per-member Team can buy; the workspace's own limit is its paid seats (org.seats).
  team_seats: { autopilot: "autopilot", insights: true, seats: 5 },
  staff: { autopilot: "autopilot", insights: true, seats: 50 },
} as const satisfies Record<Plan, { autopilot: "coach" | "batch" | "autopilot"; insights: boolean; seats: number }>;

const LEVEL_ORDER = ["coach", "drafts", "batch", "autopilot"] as const;
/** The level actually used: the chosen one, capped by what the plan allows. */
export function allowedAutopilotLevel(plan: Plan, wanted: (typeof LEVEL_ORDER)[number]): (typeof LEVEL_ORDER)[number] {
  const max = LEVEL_ORDER.indexOf(PLAN_FEATURES[plan].autopilot);
  return LEVEL_ORDER[Math.min(LEVEL_ORDER.indexOf(wanted), max)]!;
}

/** Per-member Team: between 2 and 5 paid members. */
export const TEAM_SEATS_MIN = 2;
export const TEAM_SEATS_MAX = 5;
export const clampSeats = (n: number | null | undefined) => Math.min(TEAM_SEATS_MAX, Math.max(TEAM_SEATS_MIN, Math.round(n ?? TEAM_SEATS_MIN)));

export type Limits = { [K in keyof (typeof PLAN_LIMITS)["free"]]: number };

/** A workspace's allowance: the plan's, or for a per-member Team, the per-member allowance times paid seats. */
export function limitsFor(plan: Plan, seats?: number | null): Limits {
  const base = PLAN_LIMITS[plan];
  if (plan !== "team_seats") return { ...base };
  const n = clampSeats(seats);
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v * n])) as Limits;
}

/** How many members a workspace may have. */
export function seatsFor(plan: Plan, seats?: number | null): number {
  return plan === "team_seats" ? clampSeats(seats) : PLAN_FEATURES[plan].seats;
}
