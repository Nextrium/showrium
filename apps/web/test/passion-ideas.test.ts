import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb } from "@nextrium/db";
import { createIdeas, setAsideWeakPassionIdeas } from "@nextrium/core";

// A passion's ideas under 55 are set aside automatically, so only the ones worth posting are written
// (owner decision 2026-10-21). The person's own ideas keep the earlier rules.
const BASE = "http://localhost:5173";
const DAY = 86_400_000;
let n = 0;
const ip = () => `10.54.${Math.floor(++n / 250)}.${n % 250}`;

async function user(email: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() }, body: JSON.stringify({ email, name: "I", password: "correct-horse-battery" }) });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = (method: string, path: string, body?: unknown) =>
    SELF.fetch(`${BASE}/api/v1${path}`, { method, headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  await call("PUT", "/persona", { displayName: "I", platforms: ["linkedin"] });
  const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string } };
  await env.DB.prepare("UPDATE org SET plan = 'creator' WHERE id = ?").bind(me.workspace.id).run();
  const passion = (await (await call("POST", "/passions", { name: "Cardano" })).json()) as { id: string };
  const src = `src_${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO source (id, org_id, kind, key, passion_id) VALUES (?, ?, 'rss', ?, ?)").bind(src, me.workspace.id, `https://example.com/${src}.xml`, passion.id).run();
  const own = `src_${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO source (id, org_id, kind, key) VALUES (?, ?, 'rss', ?)").bind(own, me.workspace.id, `https://example.com/${own}.xml`).run();
  return { call, orgId: me.workspace.id, passionSource: src, ownSource: own };
}

/** Stores an item and makes its idea, as a source check does. */
async function item(u: Awaited<ReturnType<typeof user>>, sourceId: string, title: string, publishedAt: Date, passion: boolean, now = new Date()) {
  const id = `ctx_${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO context_item (id, org_id, source_id, kind, title, body, published_at, external_id) VALUES (?, ?, ?, 'rss_item', ?, 'Body text.', ?, ?)").bind(id, u.orgId, sourceId, title, publishedAt.getTime(), `ext-${id}`).run();
  await createIdeas(createDb(env.DB), u.orgId, "rss_item", [{ id, title, publishedAt }], passion ? "Cardano" : undefined, { passionName: passion ? "Cardano" : null, now });
  return (await env.DB.prepare("SELECT id, status, dismissed_reason, kept, score FROM idea WHERE context_item_id = ?").bind(id).first<{ id: string; status: string; dismissed_reason: string | null; kept: number; score: number }>())!;
}

describe("a passion's weak ideas are set aside", () => {
  it("on arrival: under 55 is set aside (kept, not deleted); the person's own material isn't", async () => {
    const u = await user("pi-arrive@example.com");
    const fiveDaysAgo = new Date(Date.now() - 5 * DAY);
    // An article: 45, no freshness bonus at 5 days old, about the passion: 45 (under 55).
    const weak = await item(u, u.passionSource, "Cardano community call notes", fiveDaysAgo, true);
    expect(weak).toMatchObject({ status: "dismissed", dismissed_reason: "low_score", kept: 0 });
    // Fresh (under a day): +20, so 65: kept.
    const fresh = await item(u, u.passionSource, "Cardano governance vote opens", new Date(), true);
    expect(fresh).toMatchObject({ status: "new", dismissed_reason: null });
    // The person's own article, same age and score: stays.
    const own = await item(u, u.ownSource, "Notes from my workshop on tooling", fiveDaysAgo, false);
    expect(own).toMatchObject({ status: "new", dismissed_reason: null });
  });

  it("writing from one is refused (no AI spent) until it's brought back, and then it's never set aside again", async () => {
    const u = await user("pi-write@example.com");
    const weak = await item(u, u.passionSource, "Cardano node maintenance window", new Date(Date.now() - 5 * DAY), true);
    const refused = await u.call("POST", `/ideas/${weak.id}/compose`, { mode: "teach", platforms: ["linkedin"] });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain("set aside");
    expect((await env.DB.prepare("SELECT count(*) AS n FROM brief WHERE org_id = ?").bind(u.orgId).first<{ n: number }>())!.n).toBe(0);
    // Listed with its reason.
    const listed = (await (await u.call("GET", "/ideas?status=dismissed")).json()) as { data: { id: string; dismissedReason: string }[] };
    expect(listed.data.find((i) => i.id === weak.id)?.dismissedReason).toBe("low_score");

    expect((await u.call("POST", `/ideas/${weak.id}/restore`)).status).toBe(204);
    expect(await env.DB.prepare("SELECT status, dismissed_reason, kept FROM idea WHERE id = ?").bind(weak.id).first()).toEqual({ status: "new", dismissed_reason: null, kept: 1 });
    // The daily job leaves an idea the person kept alone.
    await setAsideWeakPassionIdeas(createDb(env.DB), new Date(Date.now() + 30 * DAY));
    expect((await env.DB.prepare("SELECT status FROM idea WHERE id = ?").bind(weak.id).first<{ status: string }>())!.status).toBe("new");
    expect((await u.call("POST", `/ideas/${weak.id}/compose`, { mode: "teach", platforms: ["linkedin"] })).status).toBe(201);
  });

  it("as they age: a fresh 65 fades under 55 and is set aside; own ideas and ones the person dismissed are untouched", async () => {
    const u = await user("pi-age@example.com");
    const now = new Date();
    const fresh = await item(u, u.passionSource, "Cardano wallet roadmap notes", now, true);
    expect(fresh.status).toBe("new");
    const own = await item(u, u.ownSource, "My article about wallets", now, false);
    const db = createDb(env.DB);
    // Two days on it's still 55 (+10): kept. Five days on it's under 55: set aside.
    await setAsideWeakPassionIdeas(db, new Date(now.getTime() + 2 * DAY));
    expect((await env.DB.prepare("SELECT status FROM idea WHERE id = ?").bind(fresh.id).first<{ status: string }>())!.status).toBe("new");
    await setAsideWeakPassionIdeas(db, new Date(now.getTime() + 5 * DAY));
    expect(await env.DB.prepare("SELECT status, dismissed_reason FROM idea WHERE id = ?").bind(fresh.id).first()).toEqual({ status: "dismissed", dismissed_reason: "low_score" });
    expect((await env.DB.prepare("SELECT status FROM idea WHERE id = ?").bind(own.id).first<{ status: string }>())!.status).toBe("new");
    // One the person dismissed keeps their reason.
    const mine = await item(u, u.passionSource, "Cardano summit tickets on sale", now, true);
    expect((await u.call("POST", `/ideas/${mine.id}/dismiss`)).status).toBe(204);
    await setAsideWeakPassionIdeas(db, new Date(now.getTime() + 5 * DAY));
    expect((await env.DB.prepare("SELECT dismissed_reason FROM idea WHERE id = ?").bind(mine.id).first<{ dismissed_reason: string }>())!.dismissed_reason).toBe("person");
  });

  it("the same story from another source lifts a set-aside idea back over 55", async () => {
    const u = await user("pi-lift@example.com");
    const threeDaysAgo = new Date(Date.now() - 3 * DAY + 3_600_000); // still within 3 days: +10
    // 45 + 10 = 55 at first would be kept, so use an older one: 45 at 5 days.
    const weak = await item(u, u.passionSource, "Cardano Plutus upgrade scheduled for mainnet", new Date(Date.now() - 5 * DAY), true);
    expect(weak.status).toBe("dismissed");
    // Another source covers the same story: +10 makes it 55, worth keeping again.
    await item(u, u.passionSource, "Plutus upgrade scheduled for Cardano mainnet", threeDaysAgo, true);
    expect(await env.DB.prepare("SELECT status, dismissed_reason, score FROM idea WHERE id = ?").bind(weak.id).first()).toEqual({ status: "new", dismissed_reason: null, score: 55 });
  });
});
