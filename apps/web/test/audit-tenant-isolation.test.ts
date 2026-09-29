// Release audit A2: tenant isolation, checked on every route that takes an id.
// Workspace B calls each route with workspace A's real ids (with valid bodies, so validation can't
// hide a leak). B must never succeed, and A's data must be unchanged afterwards.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb } from "@nextrium/db";
import { createIdeas, importTokenKey, saveConnection } from "@nextrium/core";

const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.19.${Math.floor(++n / 250)}.${n % 250}`;

async function user(email: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() },
    body: JSON.stringify({ email, name: "Iso", password: "correct-horse-battery" }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = (method: string, path: string, body?: unknown, raw?: BodyInit) =>
    SELF.fetch(`${BASE}/api/v1${path}`, {
      method,
      redirect: "manual",
      headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : raw ? { body: raw } : {}),
    });
  await call("PUT", "/persona", { displayName: "Iso", platforms: ["bluesky", "x"] });
  const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string } };
  await env.DB.prepare("UPDATE org SET plan = 'team' WHERE id = ?").bind(me.workspace.id).run();
  const row = await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>();
  return { call, orgId: me.workspace.id, userId: row!.id };
}

type Schema = { type?: string; enum?: unknown[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; minItems?: number; minimum?: number; minLength?: number; anyOf?: Schema[]; oneOf?: Schema[]; $ref?: string; format?: string };
/** A minimal valid value for a JSON schema (so requests pass validation and reach the ownership check). */
function sample(s: Schema | undefined, defs: Record<string, Schema>, depth = 0): unknown {
  if (!s || depth > 6) return undefined;
  if (s.$ref) return sample(defs[s.$ref.split("/").pop()!], defs, depth + 1);
  if (s.anyOf?.length) return sample(s.anyOf[0], defs, depth + 1);
  if (s.oneOf?.length) return sample(s.oneOf[0], defs, depth + 1);
  if (s.enum?.length) return s.enum[0];
  switch (s.type) {
    case "string":
      return s.format === "date-time" ? new Date(Date.now() + 86_400_000).toISOString() : s.format === "uri" ? "https://example.com/a" : "x".repeat(Math.max(1, s.minLength ?? 12));
    case "number":
    case "integer":
      return Math.max(1, s.minimum ?? 1);
    case "boolean":
      return false;
    case "array":
      return Array.from({ length: Math.max(1, s.minItems ?? 1) }, () => sample(s.items, defs, depth + 1));
    case "object":
    default: {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.properties ?? {})) if (s.required?.includes(k)) out[k] = sample(v, defs, depth + 1);
      return out;
    }
  }
}

describe("release audit: tenant isolation on every route with an id", () => {
  it("another workspace can't read or change anything, by any id", async () => {
    const a = await user("iso-a@example.com");
    const b = await user("iso-b@example.com");
    const db = createDb(env.DB);

    // Workspace A's resources, one of each kind.
    const ctx = (await (await a.call("POST", "/contexts", { kind: "manual", body: "We shipped retries with backoff today." })).json()) as { id: string };
    const composed = (await (await a.call("POST", "/compose", { contextItemId: ctx.id, mode: "teach", platforms: ["bluesky"] })).json()) as { drafts: { id: string }[] };
    const draftId = composed.drafts[0]!.id;
    await a.call("PATCH", `/drafts/${draftId}`, { status: "approved" });
    const form = new FormData();
    form.set("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 4, 176, 0, 0, 2, 163])], "a.png", { type: "image/png" }));
    expect((await a.call("PUT", `/drafts/${draftId}/image`, undefined, form)).status).toBe(200);
    const sourceId = `src_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO source (id, org_id, kind, key) VALUES (?, ?, 'rss', 'https://iso.example/feed')").bind(sourceId, a.orgId).run();
    const ideaCtx = `ctx_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO context_item (id, org_id, kind, title, body) VALUES (?, ?, 'manual', 'Idea', 'Body')").bind(ideaCtx, a.orgId).run();
    await createIdeas(db, a.orgId, "manual", [{ id: ideaCtx, title: "Idea" }]);
    const ideaId = (await env.DB.prepare("SELECT id FROM idea WHERE context_item_id = ?").bind(ideaCtx).first<{ id: string }>())!.id;
    const deps = { db, key: await importTokenKey(env.TOKEN_ENCRYPTION_KEY) };
    const connId = await saveConnection(deps, { orgId: a.orgId, platform: "bluesky", account: { accountId: "did:plc:iso", handle: "@iso" }, secret: { identifier: "iso", appPassword: "aaaa-bbbb-cccc-dddd" }, meta: {}, userId: a.userId });
    const videoId = `vid_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO video_project (id, org_id, timeline, model) VALUES (?, ?, ?, 'test')").bind(videoId, a.orgId, JSON.stringify({ title: "T", narration: "N", aspect: "9:16", scenes: [{ kind: "text", body: "x", durationMs: 1000 }] })).run();
    const key = (await (await a.call("POST", "/api-keys", { name: "iso" })).json()) as { id?: string; key?: { id: string } };
    const apiKeyId = key.id ?? key.key?.id ?? "";
    const invite = (await (await a.call("POST", "/team/invites", { email: "someone@example.com", role: "editor" })).json()) as { id?: string; invite?: { id: string } };
    const inviteId = invite.id ?? invite.invite?.id ?? "";
    const memberId = (await env.DB.prepare("SELECT id FROM membership WHERE org_id = ?").bind(a.orgId).first<{ id: string }>())?.id ?? "";
    const insightId = `ins_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO insight (id, org_id, themes, based_on, model) VALUES (?, ?, ?, 3, 'test')").bind(insightId, a.orgId, JSON.stringify([{ label: "L", kind: "question", count: 3, examples: [], suggestion: "S" }])).run();
    const ids = [draftId, ctx.id, sourceId, ideaId, connId, videoId, apiKeyId, inviteId, memberId, insightId, a.orgId].filter(Boolean);
    // Controls: the ids are real (A can use them), so B's refusals below mean something.
    expect(ids).toHaveLength(11);
    expect((await a.call("GET", `/drafts/${draftId}`)).status).toBe(200);
    expect((await a.call("GET", `/drafts/${draftId}/image`)).status).toBe(200);
    expect((await a.call("GET", `/ideas/${ideaId}`)).status).toBe(200);
    expect((await a.call("GET", `/videos/${videoId}`)).status).toBe(200);

    const snapshot = async () => ({
      drafts: (await env.DB.prepare("SELECT id, status, text, image IS NOT NULL AS img FROM draft WHERE org_id = ? ORDER BY id").bind(a.orgId).all()).results,
      sources: (await env.DB.prepare("SELECT id FROM source WHERE org_id = ?").bind(a.orgId).all()).results,
      ideas: (await env.DB.prepare("SELECT id, status FROM idea WHERE org_id = ?").bind(a.orgId).all()).results,
      conns: (await env.DB.prepare("SELECT id, status FROM connection WHERE org_id = ?").bind(a.orgId).all()).results,
      videos: (await env.DB.prepare("SELECT id, revisions FROM video_project WHERE org_id = ?").bind(a.orgId).all()).results,
      keys: (await env.DB.prepare("SELECT id, revoked_at FROM api_key WHERE org_id = ?").bind(a.orgId).all()).results,
      members: (await env.DB.prepare("SELECT id, role FROM membership WHERE org_id = ?").bind(a.orgId).all()).results,
    });
    const before = await snapshot();

    // Every documented route with a path parameter, plus the plain routes that take an id.
    const doc = (await (await a.call("GET", "/openapi.json")).json()) as { paths: Record<string, Record<string, { requestBody?: { content?: Record<string, { schema?: Schema }> } }>>; components?: { schemas?: Record<string, Schema> } };
    const defs = doc.components?.schemas ?? {};
    const routes: { method: string; path: string; body?: unknown }[] = [];
    for (const [path, ops] of Object.entries(doc.paths)) {
      if (!path.includes("{")) continue;
      for (const [method, op] of Object.entries(ops)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        routes.push({ method: method.toUpperCase(), path, body: sample(op.requestBody?.content?.["application/json"]?.schema, defs) });
      }
    }
    routes.push({ method: "GET", path: "/drafts/{id}/image" }, { method: "PUT", path: "/drafts/{id}/image" }, { method: "POST", path: "/videos/{id}/tiktok-inbox" });
    expect(routes.length).toBeGreaterThan(30);

    const leaks: string[] = [];
    let calls = 0;
    for (const r of routes) {
      for (const id of ids) {
        const path = r.path.replace(/\{index\}/g, "0").replace(/\{platform\}/g, "bluesky").replace(/\{org\}/g, a.orgId).replace(/\{[a-zA-Z]+\}/g, encodeURIComponent(id));
        const res = r.method === "PUT" && r.path === "/drafts/{id}/image" ? await b.call("PUT", path, undefined, form) : await b.call(r.method, path, r.method === "GET" || r.method === "DELETE" ? undefined : r.body ?? {});
        calls++;
        // Starting OAuth for a platform isn't about A's data (it redirects B to connect B's own account).
        if (res.status < 300 && !(r.path.endsWith("/start"))) leaks.push(`${r.method} ${path} → ${res.status}`);
      }
    }
    expect(leaks).toEqual([]);
    expect(calls).toBeGreaterThan(300);
    expect(await snapshot()).toEqual(before);
  }, 120_000);
});
