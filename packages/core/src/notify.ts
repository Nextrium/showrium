// Telling people what automation scheduled, before it goes out (owner decision 2026-10-18): approved
// posts are always scheduled ahead, and this email is the chance to check, cancel or let them be.
import { and, eq, inArray } from "drizzle-orm";
import { draft, membership, user, type Db, type Platform } from "@nextrium/db";
import { getAutopilot } from "./automation.js";
import { actionEmail, type Email } from "./email.js";

const NAMES: Record<Platform, string> = { x: "X", linkedin: "LinkedIn", bluesky: "Bluesky", mastodon: "Mastodon", threads: "Threads", facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", youtube_shorts: "YouTube Shorts" };

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
  const people = await db
    .select({ email: user.email, name: user.name })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(and(eq(membership.orgId, orgId), inArray(membership.role, ["owner", "admin"]), eq(user.emailVerified, true)));
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: s.timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const lines = posts
    .sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0))
    .map((p) => {
      const text = p.text.replace(/\s+/g, " ").trim();
      return `• ${NAMES[p.platform]}, ${p.at ? when.format(p.at) : "soon"}: "${text.length > 110 ? `${text.slice(0, 110)}…` : text}"`;
    });
  const n = posts.length;
  return people.slice(0, 5).map((who) =>
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
