import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.11.${Math.floor(++n / 250)}.${n % 250}`;

async function user(email: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() },
    body: JSON.stringify({ email, name: "S", password: "correct-horse-battery" }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = (method: string, path: string, body?: unknown) =>
    SELF.fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string; fullAccess: boolean } };
  return { call, orgId: me.workspace.id, fullAccess: me.workspace.fullAccess };
}

describe("full access grants", () => {
  it("only platform admins grant it; it lifts plan limits; removing it restores them; all audited", async () => {
    const tester = await user("s1tester@example.com");
    expect(tester.fullAccess).toBe(false);
    await tester.call("PUT", "/persona", { displayName: "T", platforms: ["bluesky"] });
    const autopilot = { level: "autopilot", mode: "teach", platforms: ["bluesky"], postsPerWeek: 3, publishHourUtc: 14 };
    expect((await tester.call("PUT", "/autopilot", autopilot)).status).toBe(402); // free plan

    expect((await tester.call("PUT", `/admin/orgs/${tester.orgId}/access`, { full: true, note: "self-grant" })).status).toBe(403);
    const admin = await user("admin@example.com");
    expect((await admin.call("PUT", `/admin/orgs/${tester.orgId}/access`, { full: true, note: "beta tester" })).status).toBe(204);

    const billing = (await (await tester.call("GET", "/billing")).json()) as { plan: string; fullAccess: boolean; features: { seats: number } };
    expect(billing).toMatchObject({ plan: "staff", fullAccess: true, features: { seats: 50 } });
    expect((await tester.call("PUT", "/autopilot", autopilot)).status).toBe(200);
    const granted = (await (await admin.call("GET", "/admin/access")).json()) as { data: { id: string }[] };
    expect(granted.data.map((g) => g.id)).toContain(tester.orgId);
    expect((await tester.call("GET", "/admin/access")).status).toBe(403);

    expect((await admin.call("PUT", `/admin/orgs/${tester.orgId}/access`, { full: false, note: "beta over" })).status).toBe(204);
    expect(((await (await tester.call("GET", "/billing")).json()) as { plan: string }).plan).toBe("free");
    const audit = (await (await tester.call("GET", "/audit")).json()) as { data: { action: string }[] };
    expect(audit.data.map((a) => a.action)).toEqual(expect.arrayContaining(["access.granted", "access.removed"]));
    const row = await env.DB.prepare("SELECT full_access, full_access_note FROM org WHERE id = ?").bind(tester.orgId).first<{ full_access: number; full_access_note: string | null }>();
    expect(row).toEqual({ full_access: 0, full_access_note: null });
  });
});
