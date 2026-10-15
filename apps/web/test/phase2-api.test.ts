import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "http://localhost:5173";
const ORIGIN = { Origin: BASE };
let n = 0;
const ip = () => `10.5.${Math.floor(++n / 250)}.${n % 250}`;

async function user(email: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ORIGIN, "CF-Connecting-IP": ip() },
    body: JSON.stringify({ email, name: email.split("@")[0], password: "correct-horse-battery" }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const me = (await (await SELF.fetch(`${BASE}/api/v1/me`, { headers: { Cookie: cookie } })).json()) as { workspace: { id: string } };
  return { cookie, orgId: me.workspace.id };
}
function call(cookie: string, method: string, path: string, body?: unknown) {
  return SELF.fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { Cookie: cookie, ...ORIGIN, "CF-Connecting-IP": ip(), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const PERSONA = { displayName: "Ada", role: "Engineer", expertise: ["TypeScript"], voice: "plain", platforms: ["x", "linkedin"] };
async function setup(email: string) {
  const u = await user(email);
  expect((await call(u.cookie, "PUT", "/persona", PERSONA)).status).toBe(200);
  const ctx = await call(u.cookie, "POST", "/contexts", { kind: "manual", title: "Release", body: "We shipped retries with backoff today." });
  expect(ctx.status).toBe(201);
  const { id } = (await ctx.json()) as { id: string };
  return { ...u, contextId: id };
}
const setRole = (email: string, role: string) =>
  env.DB.prepare("UPDATE membership SET role = ? WHERE user_id = (SELECT id FROM user WHERE email = ?)").bind(role, email).run();

describe("persona", () => {
  it("saves, reads back and de-duplicates platforms; nothing is preselected", async () => {
    const u = await user("p1@example.com");
    expect(((await (await call(u.cookie, "GET", "/persona")).json()) as { persona: unknown }).persona).toBeNull();
    const res = await call(u.cookie, "PUT", "/persona", { ...PERSONA, platforms: ["x", "x", "linkedin"] });
    const body = (await res.json()) as { persona: { platforms: string[] } };
    expect(body.persona.platforms).toEqual(["x", "linkedin"]);
  });
  it("rejects invalid input", async () => {
    const u = await user("p2@example.com");
    expect((await call(u.cookie, "PUT", "/persona", { displayName: "" })).status).toBe(400);
    expect((await call(u.cookie, "PUT", "/persona", { ...PERSONA, platforms: ["myspace"] })).status).toBe(400);
    expect((await call(u.cookie, "PUT", "/persona", { ...PERSONA, expertise: Array(16).fill("x") })).status).toBe(400);
  });
  it("viewers can read but not change it", async () => {
    const u = await user("p3@example.com");
    await setRole("p3@example.com", "viewer");
    expect((await call(u.cookie, "GET", "/persona")).status).toBe(200);
    expect((await call(u.cookie, "PUT", "/persona", PERSONA)).status).toBe(403);
  });
});

describe("context and sources", () => {
  it("refuses unsafe links before fetching them", async () => {
    const u = await user("c1@example.com");
    for (const url of ["http://127.0.0.1/admin", "http://localhost/", "http://169.254.169.254/latest/meta-data"]) {
      const res = await call(u.cookie, "POST", "/contexts", { kind: "url", url });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unsafe_url");
    }
  });
  it("validates GitHub repos and enforces the plan's source limit", async () => {
    const u = await user("c2@example.com");
    expect((await call(u.cookie, "POST", "/sources", { kind: "github_repo", repo: "../../etc" })).status).toBe(400);
    expect((await call(u.cookie, "POST", "/sources", { kind: "github_repo", repo: "nextrium/showrium" })).status).toBe(201);
    const second = await call(u.cookie, "POST", "/sources", { kind: "github_repo", repo: "nextrium/other" });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe("source_limit");
  });
  it("voice notes report clearly when unavailable", async () => {
    const u = await user("c3@example.com");
    const res = await call(u.cookie, "POST", "/contexts/voice", { audioBase64: "A".repeat(200) });
    expect(res.status).toBe(503);
  });
});

describe("compose", () => {
  it("needs a voice first", async () => {
    const u = await user("m1@example.com");
    const ctx = (await (await call(u.cookie, "POST", "/contexts", { kind: "manual", body: "Something worth sharing today." })).json()) as { id: string };
    const res = await call(u.cookie, "POST", "/compose", { contextItemId: ctx.id, mode: "teach", platforms: ["x"] });
    expect(res.status).toBe(409);
  });
  it("creates one linted draft per platform and counts usage", async () => {
    const u = await setup("m2@example.com");
    const res = await call(u.cookie, "POST", "/compose", { contextItemId: u.contextId, mode: "build_in_public", platforms: ["x", "linkedin"] });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { drafts: { platform: string; status: string; issues: unknown[] }[] };
    expect(out.drafts.map((d) => d.platform).sort()).toEqual(["linkedin", "x"]);
    expect(out.drafts.every((d) => d.status === "draft")).toBe(true);
    const usage = (await (await call(u.cookie, "GET", "/usage")).json()) as { posts: { used: number; limit: number } };
    expect(usage.posts).toEqual({ used: 2, limit: 20 });
  });
  it("charges credits beyond the plan and refuses when credits run out", async () => {
    const u = await setup("m3@example.com");
    const period = new Date().toISOString().slice(0, 7);
    await env.DB.prepare("INSERT INTO usage_counter (org_id, period, posts_generated) VALUES (?, ?, 19)").bind(u.orgId, period).run();
    // 1 post left + 1 extra (1 credit of the 20 welcome credits).
    expect((await call(u.cookie, "POST", "/compose", { contextItemId: u.contextId, mode: "teach", platforms: ["x", "linkedin"] })).status).toBe(201);
    const credits = (await (await call(u.cookie, "GET", "/credits")).json()) as { balance: number };
    expect(credits.balance).toBe(19);
    // Burn remaining credits, then the next request is refused.
    await env.DB.prepare("UPDATE usage_counter SET posts_generated = 1000 WHERE org_id = ?").bind(u.orgId).run();
    await env.DB.prepare(
      "INSERT INTO credit_txn (id, org_id, kind, idempotency_key, description) VALUES ('txn_burn_' || ?, ?, 'spend', 'burn', 'test')",
    ).bind(u.orgId, u.orgId).run();
    await env.DB.prepare(
      "INSERT INTO credit_entry (id, txn_id, org_id, account, amount) VALUES ('e1_' || ?, 'txn_burn_' || ?, ?, 'org', -19), ('e2_' || ?, 'txn_burn_' || ?, ?, 'platform', 19)",
    ).bind(u.orgId, u.orgId, u.orgId, u.orgId, u.orgId, u.orgId).run();
    expect((await call(u.cookie, "POST", "/compose", { contextItemId: u.contextId, mode: "teach", platforms: ["x"] })).status).toBe(402);
  });
  it("rejects unknown platforms and empty selections", async () => {
    const u = await setup("m4@example.com");
    expect((await call(u.cookie, "POST", "/compose", { contextItemId: u.contextId, mode: "teach", platforms: [] })).status).toBe(400);
    expect((await call(u.cookie, "POST", "/compose", { contextItemId: u.contextId, mode: "teach", platforms: ["orkut"] })).status).toBe(400);
  });
});

describe("drafts: permissions, states and isolation", () => {
  async function withDraft(email: string) {
    const u = await setup(email);
    const out = (await (await call(u.cookie, "POST", "/compose", { contextItemId: u.contextId, mode: "teach", platforms: ["x"] })).json()) as { drafts: { id: string }[] };
    return { ...u, draftId: out.drafts[0]!.id };
  }
  it("editing re-lints; approving a post with errors is refused", async () => {
    const u = await withDraft("d1@example.com");
    const edited = await call(u.cookie, "PATCH", `/drafts/${u.draftId}`, { text: "x".repeat(400) });
    expect(((await edited.json()) as { draft: { issues: { code: string }[] } }).draft.issues.map((i) => i.code)).toContain("too_long");
    expect((await call(u.cookie, "PATCH", `/drafts/${u.draftId}`, { status: "approved" })).status).toBe(409);
    await call(u.cookie, "PATCH", `/drafts/${u.draftId}`, { text: "Short and clear." });
    expect((await call(u.cookie, "PATCH", `/drafts/${u.draftId}`, { status: "approved" })).status).toBe(200);
  });
  it("editors can edit but not approve; approvers can approve but not edit", async () => {
    const u = await withDraft("d2@example.com");
    await setRole("d2@example.com", "editor");
    expect((await call(u.cookie, "PATCH", `/drafts/${u.draftId}`, { status: "approved" })).status).toBe(403);
    expect((await call(u.cookie, "PATCH", `/drafts/${u.draftId}`, { text: "Edited by editor." })).status).toBe(200);
    await setRole("d2@example.com", "approver");
    expect((await call(u.cookie, "PATCH", `/drafts/${u.draftId}`, { text: "Nope" })).status).toBe(403);
    expect((await call(u.cookie, "PATCH", `/drafts/${u.draftId}`, { status: "approved" })).status).toBe(200);
  });
  it("another workspace can't see, edit or compose from this one's data", async () => {
    const a = await withDraft("iso-a@example.com");
    const b = await setup("iso-b@example.com");
    expect((await call(b.cookie, "PATCH", `/drafts/${a.draftId}`, { text: "hijack" })).status).toBe(404);
    const bDrafts = (await (await call(b.cookie, "GET", "/drafts")).json()) as { data: { id: string }[] };
    expect(bDrafts.data.map((d) => d.id)).not.toContain(a.draftId);
    expect((await call(b.cookie, "POST", "/compose", { contextItemId: a.contextId, mode: "teach", platforms: ["x"] })).status).toBe(404);
  });
  it("refuses invalid state changes", async () => {
    const u = await withDraft("d3@example.com");
    await env.DB.prepare("UPDATE draft SET status = 'published' WHERE id = ?").bind(u.draftId).run();
    expect((await call(u.cookie, "PATCH", `/drafts/${u.draftId}`, { text: "rewrite history" })).status).toBe(409);
  });
});
