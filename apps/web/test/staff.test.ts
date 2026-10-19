import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb } from "@nextrium/db";
import { inviteStaff, staffCan, staffRoleFor } from "@nextrium/core";

// Staff roles: owners from PLATFORM_ADMIN_EMAILS (admin@example.com in tests), everyone else invited
// with a role. A role only gives what it lists. Staff screens and their API are in the admin app
// (apps/admin, behind Cloudflare Access); the web app only reports staff status.
const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.47.${Math.floor(++n / 250)}.${n % 250}`;

async function user(email: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() },
    body: JSON.stringify({ email, name: "S", password: "correct-horse-battery" }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = (method: string, path: string, body?: unknown) =>
    SELF.fetch(`${BASE}/api/v1${path}`, { method, headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const id = (await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>())!.id;
  return { call, id };
}

describe("invited staff", () => {
  it("a support member sees the waitlist but can't change plans; an unconfirmed email isn't staff", async () => {
    const db = createDb(env.DB);
    const helper = await user("support-staff@example.com");
    await inviteStaff(db, { email: "support-staff@example.com", role: "support", actor: { email: "admin@example.com", role: "owner" } });

    // Email not confirmed yet: not staff.
    const who = { userId: helper.id, email: "support-staff@example.com" };
    expect(await staffRoleFor(db, who, "admin@example.com")).toBeNull();
    expect(((await (await helper.call("GET", "/me")).json()) as { principal: { isPlatformAdmin: boolean } }).principal.isPlatformAdmin).toBe(false);

    await env.DB.prepare("UPDATE user SET email_verified = 1 WHERE id = ?").bind(helper.id).run();
    expect(((await (await helper.call("GET", "/me")).json()) as { principal: { isPlatformAdmin: boolean } }).principal.isPlatformAdmin).toBe(true);
    const role = await staffRoleFor(db, who, "admin@example.com");
    expect(role).toBe("support");
    expect(staffCan(role, "waitlist")).toBe(true);
    expect(staffCan(role, "users.manage")).toBe(false); // no plan changes or access grants
  });

  it("the old staff endpoints are gone from the web API, even for staff", async () => {
    const owner = await user("admin@example.com");
    const me = (await (await owner.call("GET", "/me")).json()) as { principal: { isPlatformAdmin: boolean }; workspace: { id: string } };
    expect(me.principal.isPlatformAdmin).toBe(true);
    expect((await owner.call("GET", "/admin/waitlist")).status).toBe(404);
    expect((await owner.call("GET", "/admin/orgs?email=admin@example.com")).status).toBe(404);
    expect((await owner.call("POST", "/admin/waitlist/invite", { ids: ["wl_x"] })).status).toBe(404);
    expect((await owner.call("PUT", `/admin/orgs/${me.workspace.id}/plan`, { plan: "pro", note: "self upgrade" })).status).toBe(404);
    expect((await owner.call("PUT", `/admin/orgs/${me.workspace.id}/access`, { full: true, note: "self grant" })).status).toBe(404);
    expect((await owner.call("GET", "/admin/access")).status).toBe(404);
    const doc = (await (await owner.call("GET", "/openapi.json")).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths).filter((p) => p.startsWith("/admin"))).toEqual([]);
  });

  it("only owners can invite staff", async () => {
    const db = createDb(env.DB);
    await expect(inviteStaff(db, { email: "x@example.com", role: "owner", actor: { email: "support-staff@example.com", role: "support" } })).rejects.toThrow(/Only owners/);
  });
});
