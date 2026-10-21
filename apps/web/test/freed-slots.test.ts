import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb } from "@nextrium/db";
import { failedPostEmails, fillFreedSlots, importTokenKey, saveConnection, type PublishDeps } from "@nextrium/core";

// A failed post never holds its slot: later automated posts on the account move up into the free time
// (owner report 2026-10-21: three X posts failed on the 19th and the newer ones waited for the 20th).
const BASE = "http://localhost:5173";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let n = 0;
const ip = () => `10.55.${Math.floor(++n / 250)}.${n % 250}`;

async function user(email: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() }, body: JSON.stringify({ email, name: "F", password: "correct-horse-battery" }) });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = (method: string, path: string, body?: unknown) =>
    SELF.fetch(`${BASE}/api/v1${path}`, { method, headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  await call("PUT", "/persona", { displayName: "F", platforms: ["bluesky"] });
  const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string } };
  await env.DB.prepare("UPDATE org SET plan = 'creator' WHERE id = ?").bind(me.workspace.id).run();
  await env.DB.prepare("UPDATE user SET email_verified = 1 WHERE email = ?").bind(email).run();
  const userId = (await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>())!.id;
  const saved = await call("PUT", "/autopilot", { findIdeas: false, rules: { bluesky: { write: false, schedule: true, approve: false } }, mix: { teach: 1 }, days: [0, 1, 2, 3, 4, 5, 6], publishHourUtc: 9, timezone: "UTC", windows: ["morning", "midday", "afternoon", "evening"], perDay: { bluesky: 2 } });
  expect(saved.status).toBe(200);
  const deps: PublishDeps = { db: createDb(env.DB), key: await importTokenKey(env.TOKEN_ENCRYPTION_KEY), configs: { mastodonRedirectUri: `${BASE}/cb` } };
  const conn = await saveConnection(deps, { orgId: me.workspace.id, platform: "bluesky", account: { accountId: `did:plc:${me.workspace.id}`, handle: "@f" }, secret: { identifier: "f", appPassword: "aaaa-bbbb-cccc-dddd" }, meta: {}, userId });
  return { call, orgId: me.workspace.id, conn };
}

async function post(orgId: string, conn: string, status: string, at: number, auto: boolean) {
  const id = `drf_${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO draft (id, org_id, platform, text, status, issues, connection_id, scheduled_at, auto_scheduled) VALUES (?, ?, 'bluesky', ?, ?, '[]', ?, ?, ?)").bind(id, orgId, `Post ${id}`, status, conn, at, auto ? 1 : 0).run();
  return id;
}
const at = async (id: string) => (await env.DB.prepare("SELECT scheduled_at FROM draft WHERE id = ?").bind(id).first<{ scheduled_at: number }>())!.scheduled_at;

describe("when a scheduled post fails", () => {
  it("later automated posts move up into the free time; posts the person scheduled keep theirs", async () => {
    const u = await user("fs-move@example.com");
    const now = new Date();
    const failed = await post(u.orgId, u.conn, "failed", now.getTime() + 3 * HOUR, true);
    // Waiting three and four days away (the next free times were taken when they were scheduled).
    const auto1 = await post(u.orgId, u.conn, "scheduled", now.getTime() + 3 * DAY, true);
    const auto2 = await post(u.orgId, u.conn, "scheduled", now.getTime() + 4 * DAY, true);
    const mine = await post(u.orgId, u.conn, "scheduled", now.getTime() + 5 * DAY, false);
    const before = { auto1: await at(auto1), auto2: await at(auto2), mine: await at(mine) };

    const moved = await fillFreedSlots(createDb(env.DB), u.orgId, [failed], now);
    expect(moved.map((m) => m.id)).toEqual([auto1, auto2]);
    for (const m of moved) {
      expect(m.to.getTime()).toBeLessThanOrEqual(m.from.getTime() - HOUR); // really earlier
      expect(m.to.getTime()).toBeGreaterThanOrEqual(now.getTime() + 2 * HOUR - 60_000); // still time to cancel
    }
    expect(await at(auto1)).toBeLessThan(before.auto1);
    expect(await at(mine)).toBe(before.mine); // never moved
    // Two posts a day on this account, at least 4 hours apart.
    const times = [await at(auto1), await at(auto2)].sort();
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(4 * HOUR);
    // Recorded, and the failure email says what moved.
    expect(await env.DB.prepare("SELECT count(*) AS n FROM audit_event WHERE org_id = ? AND action = 'autopilot.moved_up'").bind(u.orgId).first<{ n: number }>()).toEqual({ n: 1 });
    const email = (await failedPostEmails(createDb(env.DB), u.orgId, [failed], BASE, moved))[0]!;
    expect(email.text).toContain("moved up");
  });

  it("nothing moves when nothing waits, when the post didn't fail, or for another workspace's failure", async () => {
    const u = await user("fs-none@example.com");
    const now = new Date();
    const db = createDb(env.DB);
    // Nothing waiting: nothing to do.
    const lone = await post(u.orgId, u.conn, "failed", now.getTime() + 3 * HOUR, true);
    expect(await fillFreedSlots(db, u.orgId, [lone], now)).toEqual([]);
    // A post that isn't failed (it went out after all) frees nothing.
    const later = await post(u.orgId, u.conn, "scheduled", now.getTime() + 3 * DAY, true);
    const ok = await post(u.orgId, u.conn, "published", now.getTime() + 3 * HOUR, true);
    expect(await fillFreedSlots(db, u.orgId, [ok], now)).toEqual([]);
    expect(await at(later)).toBe(now.getTime() + 3 * DAY);
    // Another workspace's failed post never moves this one's posts.
    const other = await user("fs-other@example.com");
    const theirs = await post(other.orgId, other.conn, "failed", now.getTime() + 3 * HOUR, true);
    expect(await fillFreedSlots(db, u.orgId, [theirs], now)).toEqual([]);
    expect(await at(later)).toBe(now.getTime() + 3 * DAY);
  });
});
