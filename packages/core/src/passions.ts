// Passions: subjects a person cares about and posts on (a project, an ecosystem, a cause), each with
// up to 10 sources of its own. Posts about a passion are the person's view of someone else's work,
// with an optional disclosure. Every function filters by orgId (tenant isolation lives here).
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { contextItem, passion, PASSION_RELATIONS, source, type Db, type PassionRelation } from "@nextrium/db";
import { getOrgLimits } from "./content.js";
import { newId } from "./ids.js";

export const PASSION_NAME_MAX = 60;
export const PASSION_ABOUT_MAX = 300;
export const PASSION_DISCLOSURE_MAX = 120;

export type Passion = typeof passion.$inferSelect;
export type PassionInput = {
  name: string;
  about?: string | undefined;
  disclosure?: string | undefined;
  active?: boolean | undefined;
  startsOn?: string | null | undefined;
  endsOn?: string | null | undefined;
  relation?: PassionRelation | undefined;
  linkSource?: boolean | undefined;
};

export class PassionError extends Error {
  constructor(
    readonly code: "invalid" | "limit" | "source_limit" | "not_found" | "exists",
    message: string,
  ) {
    super(message);
    this.name = "PassionError";
  }
}

/** Today as a UTC day ("YYYY-MM-DD"); passion dates are whole days. */
export const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/** On, and today is within its dates (either date may be open). */
export function passionIsLive(p: Pick<Passion, "active" | "startsOn" | "endsOn">, today = utcDay()): boolean {
  return p.active && (!p.startsOn || p.startsOn <= today) && (!p.endsOn || p.endsOn >= today);
}

/** SQL: this source isn't part of a passion, or its passion is live today. For the polling and automation queries. */
export function sourceIsLive(sourceIdOrPassionCol: SQL | typeof source.passionId, today = utcDay()): SQL {
  return sql`(${sourceIdOrPassionCol} IS NULL OR EXISTS (SELECT 1 FROM passion p WHERE p.id = ${sourceIdOrPassionCol} AND p.active = 1 AND (p.starts_on IS NULL OR p.starts_on <= ${today}) AND (p.ends_on IS NULL OR p.ends_on >= ${today})))`;
}

function clean(input: { [K in keyof PassionInput]?: PassionInput[K] | undefined }, current?: Passion) {
  const out: Partial<typeof passion.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = input.name.trim().replace(/\s+/g, " ");
    if (!name || name.length > PASSION_NAME_MAX) throw new PassionError("invalid", `Give it a name of up to ${PASSION_NAME_MAX} characters.`);
    out.name = name;
  }
  if (input.about !== undefined) {
    if (input.about.trim().length > PASSION_ABOUT_MAX) throw new PassionError("invalid", `Keep your angle under ${PASSION_ABOUT_MAX} characters.`);
    out.about = input.about.trim();
  }
  if (input.disclosure !== undefined) {
    if (input.disclosure.trim().length > PASSION_DISCLOSURE_MAX) throw new PassionError("invalid", `Keep the disclosure under ${PASSION_DISCLOSURE_MAX} characters.`);
    out.disclosure = input.disclosure.trim();
  }
  if (input.active !== undefined) out.active = input.active;
  if (input.relation !== undefined) {
    if (!PASSION_RELATIONS.includes(input.relation)) throw new PassionError("invalid", "Choose how you're connected to it.");
    out.relation = input.relation;
  }
  if (input.linkSource !== undefined) out.linkSource = input.linkSource;
  for (const key of ["startsOn", "endsOn"] as const) {
    const v = input[key];
    if (v === undefined) continue;
    if (v !== null && v !== "" && !isDay(v)) throw new PassionError("invalid", "Use real dates.");
    out[key] = v || null;
  }
  const starts = out.startsOn !== undefined ? out.startsOn : (current?.startsOn ?? null);
  const ends = out.endsOn !== undefined ? out.endsOn : (current?.endsOn ?? null);
  if (starts && ends && starts > ends) throw new PassionError("invalid", "The end date is before the start date.");
  return out;
}

export async function listPassions(db: Db, orgId: string) {
  const rows = await db.select().from(passion).where(eq(passion.orgId, orgId)).orderBy(asc(passion.createdAt));
  const ids = rows.map((r) => r.id);
  const sources = ids.length ? await db.select().from(source).where(and(eq(source.orgId, orgId), inArray(source.passionId, ids))).orderBy(asc(source.createdAt)) : [];
  return rows.map((p) => ({ ...p, sources: sources.filter((s) => s.passionId === p.id) }));
}

export async function getPassion(db: Db, orgId: string, id: string) {
  const [row] = await db.select().from(passion).where(and(eq(passion.orgId, orgId), eq(passion.id, id)));
  return row ?? null;
}

export async function createPassion(db: Db, orgId: string, input: PassionInput) {
  const values = clean(input);
  const { limits } = await getOrgLimits(db, orgId);
  const [{ n }] = (await db.select({ n: sql<number>`count(*)` }).from(passion).where(eq(passion.orgId, orgId))) as [{ n: number }];
  if (n >= limits.passions) throw new PassionError("limit", `Your plan allows ${limits.passions} passion${limits.passions === 1 ? "" : "s"}. Remove one or upgrade.`);
  const existing = await db.select({ name: passion.name }).from(passion).where(eq(passion.orgId, orgId));
  if (existing.some((e) => e.name.toLowerCase() === values.name!.toLowerCase())) throw new PassionError("exists", "You already have a passion with that name.");
  const [row] = await db
    .insert(passion)
    .values({ id: newId("pas"), orgId, name: values.name!, about: values.about ?? "", disclosure: values.disclosure ?? "", active: values.active ?? true, startsOn: values.startsOn ?? null, endsOn: values.endsOn ?? null, relation: values.relation ?? "follow", linkSource: values.linkSource ?? true })
    .returning();
  return row!;
}

export async function updatePassion(db: Db, orgId: string, id: string, input: { [K in keyof PassionInput]?: PassionInput[K] | undefined }) {
  const current = await getPassion(db, orgId, id);
  if (!current) throw new PassionError("not_found", "No such passion in this workspace.");
  const values = clean(input, current);
  if (values.name && values.name.toLowerCase() !== current.name.toLowerCase()) {
    const others = await db.select({ name: passion.name }).from(passion).where(eq(passion.orgId, orgId));
    if (others.some((e) => e.name.toLowerCase() === values.name!.toLowerCase())) throw new PassionError("exists", "You already have a passion with that name.");
  }
  if (!Object.keys(values).length) return current;
  const [row] = await db.update(passion).set({ ...values, updatedAt: new Date() }).where(and(eq(passion.orgId, orgId), eq(passion.id, id))).returning();
  return row!;
}

/** Removes a passion and stops watching its sources. Ideas and posts already made from them stay. */
export async function removePassion(db: Db, orgId: string, id: string) {
  if (!(await getPassion(db, orgId, id))) return false;
  await db.delete(source).where(and(eq(source.orgId, orgId), eq(source.passionId, id)));
  await db.delete(passion).where(and(eq(passion.orgId, orgId), eq(passion.id, id)));
  return true;
}

/** Adds a source to a passion (up to the plan's number per passion). Returns null if it's already connected. */
export async function addPassionSource(db: Db, orgId: string, passionId: string, kind: "github_repo" | "rss" | "page", key: string) {
  if (!(await getPassion(db, orgId, passionId))) throw new PassionError("not_found", "No such passion in this workspace.");
  const { limits } = await getOrgLimits(db, orgId);
  const [{ n }] = (await db.select({ n: sql<number>`count(*)` }).from(source).where(and(eq(source.orgId, orgId), eq(source.passionId, passionId)))) as [{ n: number }];
  if (n >= limits.passionSources) throw new PassionError("source_limit", `Your plan allows ${limits.passionSources} sources per passion. Remove one or upgrade.`);
  const [row] = await db
    .insert(source)
    .values({ id: newId("src"), orgId, passionId, kind, key })
    .onConflictDoNothing({ target: [source.orgId, source.kind, source.key] })
    .returning();
  return row ?? null;
}

/** The passion a piece of material came from, if any (for writing posts about it). */
export async function passionForContext(db: Db, orgId: string, contextItemId: string) {
  const [row] = await db
    .select({ id: passion.id, name: passion.name, about: passion.about, disclosure: passion.disclosure, relation: passion.relation, linkSource: passion.linkSource })
    .from(contextItem)
    .innerJoin(source, eq(source.id, contextItem.sourceId))
    .innerJoin(passion, eq(passion.id, source.passionId))
    .where(and(eq(contextItem.orgId, orgId), eq(contextItem.id, contextItemId), eq(passion.orgId, orgId)));
  return row ?? null;
}
