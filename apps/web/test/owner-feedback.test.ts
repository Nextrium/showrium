import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb } from "@nextrium/db";
import { compose, createIdeas, getBalance, postCreditTxn } from "@nextrium/core";
import { cleanPost, fakeProvider } from "@nextrium/llm";

const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.14.${Math.floor(++n / 250)}.${n % 250}`;

async function user(email: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() },
    body: JSON.stringify({ email, name: "O", password: "correct-horse-battery" }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = (method: string, path: string, body?: unknown) =>
    SELF.fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const upload = (text: string) => {
    const form = new FormData();
    form.set("file", new File([text], "notes.txt", { type: "text/plain" }));
    return SELF.fetch(`${BASE}/api/v1/contexts/upload`, { method: "POST", headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip() }, body: form });
  };
  await call("PUT", "/persona", { displayName: "O", platforms: ["bluesky", "linkedin"] });
  const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string } };
  return { call, upload, orgId: me.workspace.id };
}

describe("house style: no hashtags, no em dashes", () => {
  it("cleans generated text", () => {
    expect(cleanPost("Shipped it — finally.\n\n#BuildInPublic #DevLife")).toBe("Shipped it, finally.");
    expect(cleanPost("I love #TypeScript tools—they help.")).toBe("I love TypeScript tools, they help.");
    expect(cleanPost("Took 2–3 days. C# and #1 stay.")).toBe("Took 2-3 days. C# and #1 stay.");
    expect(cleanPost("CAPTION: A unique kind of cardio. #TechLife #NYSC")).toBe("CAPTION: A unique kind of cardio.");
    expect(cleanPost("Line one\n#only #tags\nLine two")).toBe("Line one\n\nLine two");
  });

  it("applies to every post the writer produces", async () => {
    const u = await user("of-style@example.com");
    const ctx = (await (await u.call("POST", "/contexts", { kind: "manual", body: "We shipped retries with backoff today." })).json()) as { id: string };
    const providers = [
      fakeProvider(() =>
        JSON.stringify({
          angle: "a",
          key_points: ["k"],
          variants: [
            { platform: "bluesky", text: "Retries shipped — safer now. #devops" },
            { platform: "linkedin", text: "We shipped retries—with backoff.\n\n#Engineering #Reliability #Backend" },
          ],
        }),
      ),
    ];
    const out = await compose(createDb(env.DB), providers, { orgId: u.orgId, contextItemId: ctx.id, mode: "teach", platforms: ["bluesky", "linkedin"] });
    for (const d of out.drafts) {
      expect(d.text).not.toMatch(/[—–]|(^|\s)#\w/);
    }
  });
});

describe("uploads per plan", () => {
  it("free plan: 3 a day, then credits per extra upload, then refused with no credits", async () => {
    const u = await user("of-uploads@example.com");
    const a0 = (await (await u.call("GET", "/contexts/upload/allowance")).json()) as { used: number; limit: number; creditsPerExtra: number };
    expect(a0).toMatchObject({ used: 0, limit: 3, creditsPerExtra: 2 });
    for (let i = 0; i < 3; i++) expect((await u.upload(`Notes number ${i} from the week.`)).status).toBe(201);
    const db = createDb(env.DB);
    const before = await getBalance(db, u.orgId);
    const extra = await u.upload("An extra upload beyond the plan.");
    expect(extra.status).toBe(201);
    expect(((await extra.json()) as { creditsSpent: number }).creditsSpent).toBe(2);
    expect(await getBalance(db, u.orgId)).toBe(before - 2);
    // Spend the rest, then the next extra upload is refused.
    const rest = await getBalance(db, u.orgId);
    if (rest > 0) await postCreditTxn(db, { orgId: u.orgId, kind: "spend", amount: -rest, idempotencyKey: `drain:${u.orgId}`, description: "test" });
    expect((await u.upload("One more, with no credits left.")).status).toBe(402);
  });

  it("higher plans get more", async () => {
    const u = await user("of-uploads-pro@example.com");
    await env.DB.prepare("UPDATE org SET plan = 'pro' WHERE id = ?").bind(u.orgId).run();
    expect(((await (await u.call("GET", "/contexts/upload/allowance")).json()) as { limit: number }).limit).toBe(50);
  });
});

describe("posts show where they came from; ideas open in place", () => {
  it("drafts carry their source; one post and its siblings can be read", async () => {
    const u = await user("of-source@example.com");
    const cid = `ctx_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO context_item (id, org_id, kind, title, body) VALUES (?, ?, 'github_activity', '13 commits on acme/app', 'Fixed login. Added export.')").bind(cid, u.orgId).run();
    await createIdeas(createDb(env.DB), u.orgId, "github_activity", [{ id: cid, title: "13 commits on acme/app" }], "Your work");
    const ideas = (await (await u.call("GET", "/ideas")).json()) as { data: { id: string; kind: string }[]; counts: { new: number } };
    expect(ideas.counts.new).toBe(1);
    expect(ideas.data[0]!.kind).toBe("github_activity");
    const ideaId = ideas.data[0]!.id;

    const written = (await (await u.call("POST", `/ideas/${ideaId}/compose`, { mode: "build_in_public", platforms: ["bluesky", "linkedin"] })).json()) as { drafts: { id: string }[] };
    const list = (await (await u.call("GET", "/drafts?status=draft")).json()) as { data: { id: string; briefId: string; source: { kind: string; title: string; mode: string } }[] };
    const mine = list.data.filter((d) => written.drafts.some((w) => w.id === d.id));
    expect(mine).toHaveLength(2);
    expect(mine[0]!.source).toMatchObject({ kind: "github_activity", title: "13 commits on acme/app", mode: "build_in_public" });

    const one = (await (await u.call("GET", `/drafts/${mine[0]!.id}`)).json()) as { draft: { source: { title: string } } };
    expect(one.draft.source.title).toBe("13 commits on acme/app");
    const siblings = (await (await u.call("GET", `/drafts?briefId=${mine[0]!.briefId}`)).json()) as { data: unknown[] };
    expect(siblings.data).toHaveLength(2);

    const idea = (await (await u.call("GET", `/ideas/${ideaId}`)).json()) as { idea: { status: string; briefId: string } };
    expect(idea.idea).toMatchObject({ status: "drafted", briefId: mine[0]!.briefId });
  });

  it("dismissed ideas can come back; other workspaces can't read them", async () => {
    const u = await user("of-restore@example.com");
    const other = await user("of-restore-2@example.com");
    const cid = `ctx_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO context_item (id, org_id, kind, title, body) VALUES (?, ?, 'manual', 'A note', 'Body text here.')").bind(cid, u.orgId).run();
    await createIdeas(createDb(env.DB), u.orgId, "manual", [{ id: cid, title: "A note" }]);
    const id = ((await (await u.call("GET", "/ideas")).json()) as { data: { id: string }[] }).data[0]!.id;
    expect((await u.call("POST", `/ideas/${id}/dismiss`)).status).toBe(204);
    expect((await other.call("GET", `/ideas/${id}`)).status).toBe(404);
    expect((await other.call("POST", `/ideas/${id}/restore`)).status).toBe(404);
    expect((await u.call("POST", `/ideas/${id}/restore`)).status).toBe(204);
    expect(((await (await u.call("GET", `/ideas/${id}`)).json()) as { idea: { status: string } }).idea.status).toBe("new");
  });
});
