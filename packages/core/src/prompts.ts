// Daily prompt: one short question a day, matched to what the person does. Answering it gives
// Showrium something real to write about. Hand-written bank: no AI cost, no invented facts.
import { and, eq } from "drizzle-orm";
import { contextItem, idea, type Db } from "@nextrium/db";
import { newId } from "./ids.js";

const BANK = {
  builder: [
    "What did you fix, build or ship this week, and what was tricky about it?",
    "What's one tool or trick that saved you time recently?",
    "What bug taught you something you'd share with a newer developer?",
    "What decision in your current project would you make differently now?",
    "What's something about your stack you had to learn the hard way?",
    "What question do people ask you most at work, and how do you answer it?",
    "What would you tell yourself on day one of this project?",
  ],
  founder: [
    "What did a customer say this week that surprised you?",
    "What's one thing you stopped doing that made your team faster?",
    "What small win are you proud of this week?",
    "What's a mistake you made early on that others could avoid?",
    "What problem are you solving, in one sentence a friend would understand?",
    "What did you learn from a no this month?",
  ],
  designer: [
    "What design choice did you make this week, and why?",
    "What's a before-and-after you could explain in three steps?",
    "What feedback changed your mind recently?",
    "What's a small detail most people miss in good design?",
    "What's in your process that you'd teach a junior designer?",
  ],
  educator: [
    "What did a student teach you this week?",
    "What explanation finally made a hard idea click for your class?",
    "What small change made your lessons better?",
    "What do you wish people understood about teaching?",
    "What resource would you recommend to a learner right now?",
  ],
  creator: [
    "What are you making right now, and what's the story behind it?",
    "What's one thing you learned from your last piece of work?",
    "What inspired you this week?",
    "What does your process look like on a good day?",
    "What would you tell someone starting out in what you do?",
  ],
  marketer: [
    "What worked (or didn't) in a campaign recently, and why?",
    "What's one thing you'd change about how most people write copy?",
    "What did the numbers tell you this week that you didn't expect?",
    "What's a simple tactic a small business could use tomorrow?",
  ],
  business: [
    "What did a customer thank you for recently?",
    "What's something about your work most people never see?",
    "What changed in your business this month?",
    "What advice would you give someone opening a business like yours?",
    "What's a common question customers ask, and your honest answer?",
  ],
  health: [
    "What's one habit you recommend to people you care for?",
    "What's a myth you correct often?",
    "What made you smile at work this week?",
    "What do you wish people knew before their first visit?",
  ],
  general: [
    "What did you learn this week that you'd tell a friend?",
    "What are you working on, and why does it matter to you?",
    "What made you smile today?",
    "What's a question you were asked recently, and your answer?",
    "What's something you're better at now than a year ago?",
    "Who helped you recently, and how?",
  ],
} as const;
type Group = keyof typeof BANK;

const ROLE_GROUPS: [RegExp, Group][] = [
  [/engineer|developer|programmer|data scientist|devops|software/i, "builder"],
  [/founder|ceo|product manager|startup/i, "founder"],
  [/design/i, "designer"],
  [/teacher|lecturer|educator|tutor|student|researcher/i, "educator"],
  [/creator|writer|artist|photograph|musician|podcast/i, "creator"],
  [/market|growth|brand|social media/i, "marketer"],
  [/small business|owner|consultant|shop|freelanc/i, "business"],
  [/health|nurse|doctor|pharm|therap|coach/i, "health"],
];

/** Today's question for this workspace: steady for the day, different across days. */
export function promptFor(orgId: string, role: string, date = new Date()): { question: string; day: string } {
  const day = date.toISOString().slice(0, 10);
  const groups = ROLE_GROUPS.filter(([re]) => re.test(role)).map(([, g]) => g);
  const pool = [...new Set([...groups, "general" as const])].flatMap((g) => BANK[g]);
  let h = 0;
  for (const ch of `${orgId}:${day}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { question: pool[h % pool.length]!, day };
}

export async function todaysAnswer(db: Db, orgId: string, day: string) {
  const [row] = await db.select({ id: contextItem.id }).from(contextItem).where(and(eq(contextItem.orgId, orgId), eq(contextItem.externalId, `prompt:${day}`)));
  return row?.id ?? null;
}

export class PromptError extends Error {}

/** Saves today's answer as material and an idea. One answer per day. */
export async function answerPrompt(db: Db, orgId: string, input: { question: string; day: string; answer: string }) {
  const id = newId("ctx");
  const [row] = await db
    .insert(contextItem)
    .values({ id, orgId, kind: "prompt", title: input.question.slice(0, 300), body: `Question: ${input.question}\n\nMy answer: ${input.answer.trim()}`.slice(0, 20_000), externalId: `prompt:${input.day}` })
    .onConflictDoNothing({ target: [contextItem.orgId, contextItem.externalId] })
    .returning({ id: contextItem.id });
  if (!row) throw new PromptError("You've already answered today's question.");
  await db.insert(idea).values({ id: newId("idea"), orgId, contextItemId: row.id, reason: `Your answer: ${input.question}`.slice(0, 200), score: 75 });
  return row.id;
}
