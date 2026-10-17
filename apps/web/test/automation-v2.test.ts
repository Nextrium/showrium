import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bestWindow, localParts, openingOf, overlap, pickSlot, repeats, statsFrom, windowOf, zonedTime, type SlotInput } from "@nextrium/core";

// Automation v2 (owner decisions 2026-10-16): posting windows in the person's timezone, one post per
// window, at least 4 hours apart, per-platform daily limits, learned timing, and no repeats.
const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.48.${Math.floor(++n / 250)}.${n % 250}`;

/** A predictable "random" sequence for tests. */
function seeded(seed = 1) {
  let s = seed;
  const next = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
  for (let i = 0; i < 10; i++) next(); // small seeds start with tiny numbers: warm up first
  return next;
}
const base: Omit<SlotInput, "now"> = { tz: "UTC", days: [0, 1, 2, 3, 4, 5, 6], windows: ["morning", "midday", "afternoon", "evening"], perDay: 3, taken: [], stats: {} };

describe("timezones", () => {
  it("turns local times into instants, including daylight saving", () => {
    expect(zonedTime(2026, 10, 19, 9, 0, "Africa/Lagos").toISOString()).toBe("2026-10-19T08:00:00.000Z"); // UTC+1
    expect(zonedTime(2026, 7, 1, 9, 0, "Europe/London").toISOString()).toBe("2026-07-01T08:00:00.000Z"); // summer time
    expect(zonedTime(2026, 12, 1, 9, 0, "Europe/London").toISOString()).toBe("2026-12-01T09:00:00.000Z");
    expect(localParts(new Date("2026-10-19T23:30:00Z"), "Asia/Tokyo")).toMatchObject({ day: 20, hour: 8, weekday: 2 });
    expect(windowOf(7)).toBe("morning");
    expect(windowOf(22)).toBeNull();
  });
});

describe("choosing a posting time", () => {
  const now = new Date("2026-10-19T06:00:00Z"); // Monday, 07:00 in Lagos

  it("stays inside a window, at least 2 hours ahead, on an allowed day", () => {
    for (let seed = 1; seed < 30; seed++) {
      const at = pickSlot({ ...base, now, tz: "Africa/Lagos", days: [1, 3, 5], rand: seeded(seed) })!;
      const local = localParts(at, "Africa/Lagos");
      expect(windowOf(local.hour)).not.toBeNull();
      expect([1, 3, 5]).toContain(local.weekday);
      expect(at.getTime()).toBeGreaterThanOrEqual(now.getTime() + 2 * 3600_000);
    }
  });

  it("keeps posts 4 hours apart, one per window, and within the daily number", () => {
    const taken: Date[] = [];
    for (let i = 0; i < 6; i++) {
      const at = pickSlot({ ...base, now, perDay: 2, taken: [...taken], rand: seeded(i + 3) })!;
      expect(taken.every((t) => Math.abs(t.getTime() - at.getTime()) >= 4 * 3600_000)).toBe(true);
      taken.push(at);
    }
    const perDay = new Map<string, number>();
    for (const t of taken) perDay.set(t.toISOString().slice(0, 10), (perDay.get(t.toISOString().slice(0, 10)) ?? 0) + 1);
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(2);
    const windowsPerDay = new Set(taken.map((t) => `${t.toISOString().slice(0, 10)}-${windowOf(t.getUTCHours())}`));
    expect(windowsPerDay.size).toBe(taken.length); // never two in one window on one day
  });

  it("isn't on the hour like clockwork, and gives up only when nothing fits", () => {
    const minutes = new Set(Array.from({ length: 20 }, (_, i) => pickSlot({ ...base, now, rand: seeded(i + 11) })!.getUTCMinutes()));
    expect(minutes.size).toBeGreaterThan(5);
    expect(pickSlot({ ...base, now, days: [] })).toBeNull();
  });

  it("learns the window that does best, and still tries others early on", () => {
    // 30 evening posts did 3x better than 30 morning ones.
    const posts = [
      ...Array.from({ length: 30 }, (_, i) => ({ at: new Date(Date.UTC(2026, 8, 1 + i, 20, 0)), score: 30 })),
      ...Array.from({ length: 30 }, (_, i) => ({ at: new Date(Date.UTC(2026, 8, 1 + i, 8, 0)), score: 10 })),
    ];
    const stats = statsFrom(posts, "UTC");
    expect(stats.evening!.mean).toBeGreaterThan(stats.morning!.mean);
    expect(bestWindow(stats)).toMatchObject({ window: "evening" });
    const picks = Array.from({ length: 40 }, (_, i) => windowOf(pickSlot({ ...base, now, windows: ["morning", "evening"], stats, rand: seeded(i + 100) })!.getUTCHours()));
    expect(picks.filter((w) => w === "evening").length).toBeGreaterThan(30);
    // With no history, both windows get chosen (exploring).
    const early = new Set(Array.from({ length: 40 }, (_, i) => windowOf(pickSlot({ ...base, now, windows: ["morning", "evening"], rand: seeded(i + 200) })!.getUTCHours())));
    expect(early).toEqual(new Set(["morning", "evening"]));
    expect(bestWindow(statsFrom(posts.slice(0, 3), "UTC"))).toBeNull(); // too few posts to say
  });
});

describe("no repeats", () => {
  it("spots the same opening, and much of the same wording", () => {
    const recent = ["Retries used to fail silently. Here's what we changed and why it matters for background jobs."];
    expect(repeats("Retries used to fail silently. This time it's about the database.", recent)).toMatchObject({ repeated: true });
    expect(repeats("A different start. Retries used to fail silently here's what we changed and why it matters for background jobs.", recent)).toMatchObject({ repeated: true });
    expect(repeats("We moved our docs to a new site, and search got faster.", recent)).toEqual({ repeated: false });
    expect(overlap("one two three four", "one two three four")).toBe(1);
    expect(openingOf("First line here.\nSecond line.")).toBe("First line here.");
  });

  it("flags a new post that repeats a recent one (so automation won't approve it)", async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() }, body: JSON.stringify({ email: "v2-repeat@example.com", name: "R", password: "correct-horse-battery" }) });
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const call = (method: string, path: string, body?: unknown) => SELF.fetch(`${BASE}/api/v1${path}`, { method, headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    await call("PUT", "/persona", { displayName: "R", platforms: ["linkedin"] });
    const ctx = (await (await call("POST", "/contexts", { kind: "manual", body: "We shipped retries with backoff today." })).json()) as { id: string };
    // The test writer returns the same text every time: the second post repeats the first.
    const first = (await (await call("POST", "/compose", { contextItemId: ctx.id, mode: "teach", platforms: ["linkedin"] })).json()) as { drafts: { issues: { code: string }[] }[] };
    expect(first.drafts[0]!.issues.map((i) => i.code)).not.toContain("too_similar");
    const second = (await (await call("POST", "/compose", { contextItemId: ctx.id, mode: "teach", platforms: ["linkedin"] })).json()) as { drafts: { issues: { code: string }[] }[] };
    expect(second.drafts[0]!.issues.map((i) => i.code)).toContain("too_similar");
  });
});

describe("settings", () => {
  it("what the timing has learned is private to the signed-in workspace", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/autopilot/timing`, { headers: { Origin: BASE, "CF-Connecting-IP": ip() } });
    expect(res.status).toBe(401);
  });

  it("saves timezone, times of day and posts per day, and keeps them when an older app leaves them out", async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() }, body: JSON.stringify({ email: "v2-settings@example.com", name: "S", password: "correct-horse-battery" }) });
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const call = (method: string, path: string, body?: unknown) => SELF.fetch(`${BASE}/api/v1${path}`, { method, headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    await call("PUT", "/persona", { displayName: "S", platforms: ["bluesky", "x"] });
    const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string } };
    await env.DB.prepare("UPDATE org SET plan = 'creator' WHERE id = ?").bind(me.workspace.id).run();
    const base = { findIdeas: true, rules: { bluesky: { write: true, schedule: true, approve: false }, x: { write: true, schedule: false, approve: false } }, mix: { teach: 2, smile: 1 }, days: [1, 2, 3, 4, 5], publishHourUtc: 9 };
    const saved = await call("PUT", "/autopilot", { ...base, timezone: "Africa/Lagos", windows: ["morning", "afternoon", "evening"], perDay: { bluesky: 3, x: 2 } });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ timezone: "Africa/Lagos", windows: ["morning", "afternoon", "evening"], perDay: { bluesky: 3, x: 2 } });
    const again = await call("PUT", "/autopilot", base); // no timezone, windows or perDay
    expect(await again.json()).toMatchObject({ timezone: "Africa/Lagos", perDay: { bluesky: 3, x: 2 } });
  });
});
