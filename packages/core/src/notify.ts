// Telling people what automation scheduled, before it goes out (owner decision 2026-10-18): approved
// posts are always scheduled ahead, and this email is the chance to check, cancel or let them be.
import { and, asc, eq, gt, gte, inArray, isNull } from "drizzle-orm";
import { draft, membership, user, type Db, type Platform } from "@nextrium/db";
import { getAutopilot } from "./automation.js";
import { actionEmail, type Email } from "./email.js";
import { inQuietHours, NEEDS_YOU_ALERTS_PER_DAY } from "./idea-score.js";
import { localDay, localParts } from "./timing.js";

const NAMES: Record<Platform, string> = { x: "X", linkedin: "LinkedIn", bluesky: "Bluesky", mastodon: "Mastodon", threads: "Threads", facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", youtube_shorts: "YouTube Shorts" };

/** Owners and admins with a confirmed email (at most 5): who hears about a workspace's posts. */
async function notifyWho(db: Db, orgId: string) {
  return (
    await db
      .select({ email: user.email, name: user.name })
      .from(membership)
      .innerJoin(user, eq(user.id, membership.userId))
      .where(and(eq(membership.orgId, orgId), inArray(membership.role, ["owner", "admin"]), eq(user.emailVerified, true)))
  ).slice(0, 5);
}

/**
 * The emails to send when scheduled posts didn't go out: what, when and the platform's reason.
 * Always sent (it's rare and needs action), whatever the automation email setting.
 */
export async function failedPostEmails(db: Db, orgId: string, draftIds: string[], appUrl: string, movedUp: { platform: Platform; to: Date }[] = []): Promise<Email[]> {
  if (!draftIds.length) return [];
  const posts = await db
    .select({ platform: draft.platform, text: draft.text, at: draft.scheduledAt, why: draft.lastError })
    .from(draft)
    .where(and(eq(draft.orgId, orgId), inArray(draft.id, draftIds.slice(0, 20)), inArray(draft.status, ["failed", "approved"])));
  if (!posts.length) return [];
  const s = await getAutopilot(db, orgId);
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: s.timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const lines = posts.map((p) => {
    const text = p.text.replace(/\s+/g, " ").trim();
    return `• ${NAMES[p.platform]}${p.at ? `, ${when.format(p.at)}` : ""}: "${text.length > 80 ? `${text.slice(0, 80)}…` : text}"\n  ${p.why ?? "It didn't go out."}`;
  });
  const n = posts.length;
  // Later automated posts that moved up into the free time, so the day isn't left empty.
  const moved = movedUp.length
    ? `\n\nTo fill the free time, ${movedUp.length === 1 ? "this automated post moved up" : "these automated posts moved up"}:\n${movedUp.map((m) => `• ${NAMES[m.platform]}, now ${when.format(m.to)}`).join("\n")}`
    : "";
  return (await notifyWho(db, orgId)).map((who) =>
    actionEmail({
      to: who.email,
      name: who.name,
      subject: n === 1 ? "A scheduled post didn't go out" : `${n} scheduled posts didn't go out`,
      intro: `${n === 1 ? "This post" : "These posts"} didn't go out at the scheduled time (${s.timezone}):\n\n${lines.join("\n")}${moved}`,
      button: n === 1 ? "See the post" : "See the posts",
      url: `${new URL(appUrl).origin}/app/posts?status=failed`,
      outro: "Fix what's needed, then post it now or schedule it again. Nothing else is affected.",
    }),
  );
}

/**
 * Cron: "needs you" emails for time-sensitive posts automation couldn't fit in time. Grouped per
 * workspace, at most 3 posts a day, never in the quiet hours (22:00 to 07:00 local; they wait for the
 * morning), and each post at most once. Posts beyond the day's 3 are still shown in the app.
 */
export async function sendNeedsYouNotices(db: Db, appUrl: string, send: (emails: Email[]) => Promise<unknown>, now = new Date()) {
  const due = await db
    .select({ id: draft.id, orgId: draft.orgId, platform: draft.platform, text: draft.text, until: draft.urgentUntil })
    .from(draft)
    .where(and(gt(draft.urgentUntil, now), isNull(draft.urgentNotifiedAt), inArray(draft.status, ["draft", "approved"])))
    .orderBy(asc(draft.urgentUntil))
    .limit(200);
  const byOrg = new Map<string, typeof due>();
  for (const d of due) byOrg.set(d.orgId, [...(byOrg.get(d.orgId) ?? []), d]);
  let sent = 0;
  for (const [orgId, posts] of byOrg) {
    const s = await getAutopilot(db, orgId);
    if (inQuietHours(localParts(now, s.timezone).hour)) continue;
    const today = localDay(now, s.timezone);
    const recent = await db.select({ at: draft.urgentNotifiedAt }).from(draft).where(and(eq(draft.orgId, orgId), gte(draft.urgentNotifiedAt, new Date(now.getTime() - 86_400_000))));
    const left = NEEDS_YOU_ALERTS_PER_DAY - recent.filter((r) => r.at && localDay(r.at, s.timezone) === today).length;
    if (left <= 0) continue;
    const pick = posts.slice(0, left);
    const when = new Intl.DateTimeFormat("en-GB", { timeZone: s.timezone, weekday: "short", hour: "2-digit", minute: "2-digit" });
    const lines = pick.map((p) => {
      const text = p.text.replace(/\s+/g, " ").trim();
      return `• ${NAMES[p.platform]}, best posted before ${when.format(p.until!)}: "${text.length > 90 ? `${text.slice(0, 90)}…` : text}"`;
    });
    const n = pick.length;
    const emails = (await notifyWho(db, orgId)).map((who) =>
      actionEmail({
        to: who.email,
        name: who.name,
        subject: n === 1 ? "A time-sensitive post needs you" : `${n} time-sensitive posts need you`,
        intro: `${n === 1 ? "This is fresh news" : "These are fresh news"}, and today's automated posts are already used, so ${n === 1 ? "it waits" : "they wait"} for you (${s.timezone}):\n\n${lines.join("\n")}`,
        button: n === 1 ? "See it" : "See them",
        url: `${new URL(appUrl).origin}/app/posts?needs=1`,
        outro: "Post now, post it yourself, pick a time today, or skip it. After the time shown it's no longer news.",
      }),
    );
    await send(emails);
    await db.update(draft).set({ urgentNotifiedAt: now }).where(and(eq(draft.orgId, orgId), inArray(draft.id, pick.map((p) => p.id))));
    sent += n;
  }
  return sent;
}

/** The emails to send for posts automation just scheduled: one per owner or admin with a confirmed email. */
export async function autoScheduledEmails(db: Db, orgId: string, draftIds: string[], appUrl: string): Promise<Email[]> {
  if (!draftIds.length) return [];
  const s = await getAutopilot(db, orgId);
  if (!s.notifyEmail) return [];
  const posts = await db
    .select({ platform: draft.platform, text: draft.text, at: draft.scheduledAt })
    .from(draft)
    .where(and(eq(draft.orgId, orgId), inArray(draft.id, draftIds.slice(0, 20)), eq(draft.status, "scheduled")));
  if (!posts.length) return [];
  const people = await notifyWho(db, orgId);
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: s.timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const lines = posts
    .sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0))
    .map((p) => {
      const text = p.text.replace(/\s+/g, " ").trim();
      return `• ${NAMES[p.platform]}, ${p.at ? when.format(p.at) : "soon"}: "${text.length > 110 ? `${text.slice(0, 110)}…` : text}"`;
    });
  const n = posts.length;
  return people.map((who) =>
    actionEmail({
      to: who.email,
      name: who.name,
      subject: n === 1 ? "A post is scheduled: check it before it goes out" : `${n} posts are scheduled: check them before they go out`,
      intro: `Automation approved and scheduled ${n === 1 ? "this post" : "these posts"}. ${n === 1 ? "It goes" : "They go"} out at these times (${s.timezone}) unless you cancel:\n\n${lines.join("\n")}`,
      button: n === 1 ? "Check it" : "Check them",
      url: `${new URL(appUrl).origin}/app/posts?status=scheduled`,
      outro: "Nothing to do if they look right. You can edit, move or cancel any of them until it goes out, and turn these emails off in Automation.",
    }),
  );
}
