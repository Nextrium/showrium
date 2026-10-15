// Release audit A7: privacy rights. A copy of your data; deleting your account removes your data
// and files, never someone else's, and never leaves a paid plan running.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.20.${Math.floor(++n / 250)}.${n % 250}`;
const media = () => (env as unknown as { MEDIA: R2Bucket }).MEDIA;

async function user(email: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() },
    body: JSON.stringify({ email, name: "Priv", password: "correct-horse-battery" }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    SELF.fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  await call("PUT", "/persona", { displayName: "Priv", platforms: ["bluesky"] });
  const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string } };
  const row = await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>();
  return { call, orgId: me.workspace.id, userId: row!.id, email };
}

describe("release audit: privacy rights", () => {
  it("exports the workspace's data without secrets", async () => {
    const u = await user("priv-export@example.com");
    await u.call("POST", "/contexts", { kind: "manual", body: "Notes about our launch week." });
    const res = await u.call("GET", "/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="showrium-export-/);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toMatchObject({ format: "showrium-export/1", you: { email: "priv-export@example.com" } });
    expect((data.material as unknown[]).length).toBe(1);
    const text = JSON.stringify(data);
    expect(text).not.toMatch(/"secret"|appPassword|accessToken|"password"|key_hash/);
  });

  it("deletes the account, its own workspace and files, after the email is typed", async () => {
    const u = await user("priv-delete@example.com");
    await media().put(`orgs/${u.orgId}/uploads/a.txt`, "hello");
    await media().put(`orgs/${u.orgId}/images/b.jpg`, "img");
    expect((await u.call("POST", "/account/delete", { confirmEmail: "wrong@example.com" })).status).toBe(400);
    const res = await u.call("POST", "/account/delete", { confirmEmail: "Priv-Delete@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspacesDeleted: 1, filesDeleted: 2 });
    expect(await env.DB.prepare("SELECT id FROM user WHERE id = ?").bind(u.userId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM org WHERE id = ?").bind(u.orgId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM context_item WHERE org_id = ?").bind(u.orgId).first()).toBeNull();
    expect((await media().list({ prefix: `orgs/${u.orgId}/` })).objects).toHaveLength(0);
    expect((await u.call("GET", "/me")).status).toBe(401); // the session is gone too
  });

  it("won't leave a shared workspace without an owner, or a paid plan running", async () => {
    const owner = await user("priv-owner@example.com");
    const member = await user("priv-member@example.com");
    await env.DB.prepare("INSERT INTO membership (id, org_id, user_id, role) VALUES (?, ?, ?, 'editor')").bind(`mem_${crypto.randomUUID()}`, owner.orgId, member.userId).run();
    const blocked = await owner.call("POST", "/account/delete", { confirmEmail: owner.email });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("sole_owner");
    // The member can leave: only their membership and their own workspace go; the shared workspace stays.
    expect((await member.call("POST", "/account/delete", { confirmEmail: member.email })).status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM org WHERE id = ?").bind(owner.orgId).first()).not.toBeNull();

    const paying = await user("priv-paying@example.com");
    await env.DB.prepare("INSERT INTO subscription (id, org_id, provider, plan, interval, status, provider_subscription_id) VALUES (?, ?, 'paystack', 'starter', 'month', 'active', 'SUB_x')").bind(`sub_${crypto.randomUUID()}`, paying.orgId).run();
    const r = await paying.call("POST", "/account/delete", { confirmEmail: paying.email });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("active_plan");
  });

  it("API keys can't export or delete", async () => {
    const u = await user("priv-key@example.com");
    const { key } = (await (await u.call("POST", "/api-keys", { name: "k" })).json()) as { key: string };
    const asKey = (method: string, path: string, body?: unknown) =>
      SELF.fetch(`${BASE}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect((await asKey("GET", "/export")).status).toBe(403);
    expect((await asKey("POST", "/account/delete", { confirmEmail: u.email })).status).toBe(403);
  });
});
