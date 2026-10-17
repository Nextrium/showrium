import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb } from "@nextrium/db";
import { passionIsLive, runSourcePolling, withDisclosure } from "@nextrium/core";
import { composeSystemPrompt, composeUserPrompt } from "@nextrium/llm";

// Passions (owner decision 2026-10-16, name confirmed 2026-10-17): subjects a person cares about,
// each with its own sources. Free: 1 passion with 3 sources; paid plans up to 10 sources each.
const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.49.${Math.floor(++n / 250)}.${n % 250}`;

async function user(email: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() }, body: JSON.stringify({ email, name: "P", password: "correct-horse-battery" }) });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = (method: string, path: string, body?: unknown) =>
    SELF.fetch(`${BASE}/api/v1${path}`, { method, headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  await call("PUT", "/persona", { displayName: "P", platforms: ["linkedin"] });
  const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string } };
  return { call, orgId: me.workspace.id };
}
type P = { id: string; name: string; live: boolean; active: boolean; sources: { id: string; key: string }[] };

describe("passions", () => {
  it("free: one passion with three sources of its own, which don't use up the plan's sources", async () => {
    const u = await user("pas-free@example.com");
    const made = await u.call("POST", "/passions", { name: "  Cardano  ", about: "I build on it", disclosure: "I'm a Cardano ambassador" });
    expect(made.status).toBe(201);
    const p = (await made.json()) as P;
    expect(p).toMatchObject({ name: "Cardano", live: true, active: true, sources: [] });
    expect((await u.call("POST", "/passions", { name: "AI" })).status).toBe(409); // Free allows 1

    for (const repo of ["input-output-hk/cardano-node", "input-output-hk/plutus", "cardano-foundation/cip"]) {
      expect((await u.call("POST", `/passions/${p.id}/sources`, { kind: "github_repo", repo })).status).toBe(201);
    }
    const fourth = await u.call("POST", `/passions/${p.id}/sources`, { kind: "github_repo", repo: "input-output-hk/ouroboros" });
    expect(fourth.status).toBe(409);
    expect(((await fourth.json()) as { error: { code: string } }).error.code).toBe("source_limit");
    // The same repository can't be connected twice.
    expect((await u.call("POST", "/sources", { kind: "github_repo", repo: "input-output-hk/plutus" })).status).toBe(409);
    // The person's own source still fits (Free: 1), and Sources lists only their own.
    expect((await u.call("POST", "/sources", { kind: "github_repo", repo: "me/my-app" })).status).toBe(201);
    const own = (await (await u.call("GET", "/sources")).json()) as { data: { key: string }[] };
    expect(own.data.map((s) => s.key)).toEqual(["me/my-app"]);
    const list = (await (await u.call("GET", "/passions")).json()) as { data: P[]; limits: { passions: number; sourcesEach: number } };
    expect(list.limits).toEqual({ passions: 1, sourcesEach: 3 });
    expect(list.data[0]!.sources).toHaveLength(3);
  });

  it("paid plans: more passions, up to 10 sources each; names are unique; dates and lengths are checked", async () => {
    const u = await user("pas-creator@example.com");
    await env.DB.prepare("UPDATE org SET plan = 'creator' WHERE id = ?").bind(u.orgId).run();
    for (const name of ["Cardano", "AI", "Open source"]) expect((await u.call("POST", "/passions", { name })).status).toBe(201);
    expect((await u.call("POST", "/passions", { name: "One more" })).status).toBe(409); // Creator allows 3
    const list = (await (await u.call("GET", "/passions")).json()) as { data: P[]; limits: { passions: number; sourcesEach: number } };
    expect(list.limits).toEqual({ passions: 3, sourcesEach: 10 });
    const ai = list.data.find((p) => p.name === "AI")!;
    expect((await u.call("PATCH", `/passions/${ai.id}`, { name: "cardano" })).status).toBe(409); // already used, any case
    expect((await u.call("PATCH", `/passions/${ai.id}`, { startsOn: "2026-12-01", endsOn: "2026-11-01" })).status).toBe(400);
    expect((await u.call("PATCH", `/passions/${ai.id}`, { startsOn: "2026-02-30" })).status).toBe(400);
    expect((await u.call("PATCH", `/passions/${ai.id}`, { disclosure: "x".repeat(121) })).status).toBe(400);
    expect((await u.call("POST", "/passions", { name: "x".repeat(61) })).status).toBe(400);
  });

  it("switching off or ending a passion stops it; removing it stops watching its sources", async () => {
    const u = await user("pas-switch@example.com");
    const p = (await (await u.call("POST", "/passions", { name: "Bitcoin" })).json()) as P;
    const off = (await (await u.call("PATCH", `/passions/${p.id}`, { active: false })).json()) as P;
    expect(off).toMatchObject({ active: false, live: false });
    const ended = (await (await u.call("PATCH", `/passions/${p.id}`, { active: true, endsOn: "2020-01-01" })).json()) as P;
    expect(ended.live).toBe(false);
    const again = (await (await u.call("PATCH", `/passions/${p.id}`, { endsOn: null })).json()) as P;
    expect(again.live).toBe(true);

    await u.call("POST", `/passions/${p.id}/sources`, { kind: "github_repo", repo: "bitcoin/bitcoin" });
    expect((await u.call("DELETE", `/passions/${p.id}`)).status).toBe(204);
    const left = await env.DB.prepare("SELECT count(*) AS n FROM source WHERE org_id = ? AND passion_id IS NOT NULL").bind(u.orgId).first<{ n: number }>();
    expect(left?.n).toBe(0);
    const audit = await env.DB.prepare("SELECT action FROM audit_event WHERE org_id = ? AND action LIKE 'passion.%'").bind(u.orgId).all<{ action: string }>();
    expect(audit.results.map((a) => a.action)).toEqual(expect.arrayContaining(["passion.created", "passion.updated", "passion.removed"]));
  });

  it("is private to its workspace, and viewers can't change it", async () => {
    const a = await user("pas-a@example.com");
    const b = await user("pas-b@example.com");
    const p = (await (await a.call("POST", "/passions", { name: "Ethereum" })).json()) as P;
    expect((await b.call("PATCH", `/passions/${p.id}`, { active: false })).status).toBe(404);
    expect((await b.call("DELETE", `/passions/${p.id}`)).status).toBe(404);
    expect((await b.call("POST", `/passions/${p.id}/sources`, { kind: "github_repo", repo: "ethereum/go-ethereum" })).status).toBe(404);
    expect(((await (await b.call("GET", "/passions")).json()) as { data: P[] }).data).toEqual([]);
    await env.DB.prepare("UPDATE membership SET role = 'viewer' WHERE org_id = ?").bind(a.orgId).run();
    expect((await a.call("PATCH", `/passions/${p.id}`, { active: false })).status).toBe(403);
    expect((await a.call("GET", "/passions")).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/api/v1/passions`, { headers: { Origin: BASE, "CF-Connecting-IP": ip() } })).status).toBe(401);
  });

  it("a passion that's off isn't checked; a live one is", async () => {
    const u = await user("pas-poll@example.com");
    const live = (await (await u.call("POST", "/passions", { name: "Live one" })).json()) as P;
    await u.call("POST", `/passions/${live.id}/sources`, { kind: "github_repo", repo: "live/repo" });
    await env.DB.prepare("UPDATE org SET plan = 'creator' WHERE id = ?").bind(u.orgId).run();
    const off = (await (await u.call("POST", "/passions", { name: "Paused one", active: false })).json()) as P;
    await u.call("POST", `/passions/${off.id}/sources`, { kind: "github_repo", repo: "paused/repo" });
    const asked: string[] = [];
    await runSourcePolling(createDb(env.DB), { fetch: async (url: string) => (asked.push(url), Response.json([])) }, new Date(), 500);
    expect(asked.some((u) => u.includes("live/repo"))).toBe(true);
    expect(asked.some((u) => u.includes("paused/repo"))).toBe(false);
  });

  it("posts about a passion are the person's view, end with the disclosure, and never auto-approve", async () => {
    const u = await user("pas-compose@example.com");
    const p = (await (await u.call("POST", "/passions", { name: "Cardano", disclosure: "#ad I'm a Cardano ambassador" })).json()) as P;
    await u.call("POST", `/passions/${p.id}/sources`, { kind: "github_repo", repo: "cardano/news" });
    const src = await env.DB.prepare("SELECT id FROM source WHERE org_id = ? AND passion_id = ?").bind(u.orgId, p.id).first<{ id: string }>();
    const ctxId = `ctx_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO context_item (id, org_id, source_id, kind, title, body) VALUES (?, ?, ?, 'rss_item', 'Node 10 released', 'The Cardano node 10 release adds faster sync.')").bind(ctxId, u.orgId, src!.id).run();
    const out = (await (await u.call("POST", "/compose", { contextItemId: ctxId, mode: "teach", platforms: ["linkedin"] })).json()) as { drafts: { text: string; issues: { code: string }[] }[] };
    // Kept word for word: house-style cleanup (which drops hashtags) doesn't touch it.
    expect(out.drafts[0]!.text.endsWith("#ad I'm a Cardano ambassador")).toBe(true);
    const brief = await env.DB.prepare("SELECT stance FROM brief WHERE org_id = ? AND context_item_id = ?").bind(u.orgId, ctxId).first<{ stance: string }>();
    expect(brief?.stance).toBe("other");
  });
});

describe("passion helpers", () => {
  it("knows when a passion is live, and adds the disclosure once", () => {
    expect(passionIsLive({ active: true, startsOn: null, endsOn: null }, "2026-10-17")).toBe(true);
    expect(passionIsLive({ active: false, startsOn: null, endsOn: null }, "2026-10-17")).toBe(false);
    expect(passionIsLive({ active: true, startsOn: "2026-11-01", endsOn: null }, "2026-10-17")).toBe(false);
    expect(passionIsLive({ active: true, startsOn: "2026-10-01", endsOn: "2026-10-17" }, "2026-10-17")).toBe(true);
    expect(passionIsLive({ active: true, startsOn: null, endsOn: "2026-10-16" }, "2026-10-17")).toBe(false);
    expect(withDisclosure("A post.", "I'm an ambassador")).toBe("A post.\n\nI'm an ambassador");
    expect(withDisclosure("A post. I'm  an AMBASSADOR", "I'm an ambassador")).toBe("A post. I'm  an AMBASSADOR");
  });

  it("tells the writer it's the person's view of the subject, not the subject's voice", () => {
    const prompt = composeUserPrompt({ mode: "teach", platforms: ["linkedin"], contextTitle: "t", contextBody: "b", stance: "other", passion: { name: "Cardano", about: "I run a stake pool", disclosure: "I'm a Cardano ambassador" } });
    expect(prompt).toContain("about Cardano, a subject the author follows and cares about");
    expect(prompt).toContain("never as Cardano itself");
    expect(prompt).toContain("I run a stake pool");
    expect(prompt).toContain('"I\'m a Cardano ambassador"');
    expect(composeUserPrompt({ mode: "teach", platforms: ["linkedin"], contextTitle: "t", contextBody: "b" })).not.toContain("Passion:");
    // Every post: the writer stays in the person's language (a model once answered English material in Chinese).
    expect(composeSystemPrompt({ displayName: "P", role: "", expertise: [], interests: [], audience: "", voice: "", avoid: [] })).toContain("Never switch to another language on your own.");
  });
});
