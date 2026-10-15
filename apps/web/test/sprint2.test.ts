import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb } from "@nextrium/db";
import { parseFeed, promptFor, syncSource } from "@nextrium/core";

const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.12.${Math.floor(++n / 250)}.${n % 250}`;

async function user(email: string, role = "") {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() },
    body: JSON.stringify({ email, name: "S2", password: "correct-horse-battery" }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = (method: string, path: string, body?: unknown) =>
    SELF.fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const upload = (file: Blob, name: string, caption = "") => {
    const form = new FormData();
    form.set("file", new File([file], name, { type: file.type }));
    if (caption) form.set("caption", caption);
    return SELF.fetch(`${BASE}/api/v1/contexts/upload`, { method: "POST", headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip() }, body: form });
  };
  await call("PUT", "/persona", { displayName: "S", role, platforms: ["bluesky"] });
  const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string } };
  return { call, upload, orgId: me.workspace.id };
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("daily prompt", () => {
  it("matches the person's work and stays the same all day", () => {
    const a = promptFor("org_1", "Software engineer", new Date("2026-09-28T08:00:00Z"));
    expect(promptFor("org_1", "Software engineer", new Date("2026-09-28T20:00:00Z"))).toEqual(a);
    expect(a.day).toBe("2026-09-28");
    const days = new Set(Array.from({ length: 10 }, (_, i) => promptFor("org_1", "Teacher", new Date(Date.UTC(2026, 8, i + 1))).question));
    expect(days.size).toBeGreaterThan(3);
  });

  it("an answer becomes material and an idea, once a day; the question comes from the server", async () => {
    const u = await user("s2prompt@example.com", "Teacher");
    const p = (await (await u.call("GET", "/prompt")).json()) as { question: string; answeredContextId: string | null };
    expect(p.answeredContextId).toBeNull();
    expect((await u.call("POST", "/prompt/answer", { answer: "short" })).status).toBe(400);
    const res = await u.call("POST", "/prompt/answer", { answer: "A student showed me a faster way to explain fractions.", question: "Injected question" });
    expect(res.status).toBe(201);
    const { contextItemId } = (await res.json()) as { contextItemId: string };
    const row = await env.DB.prepare("SELECT title, body FROM context_item WHERE id = ?").bind(contextItemId).first<{ title: string; body: string }>();
    expect(row!.title).toBe(p.question);
    expect(row!.body).not.toContain("Injected");
    expect((await u.call("POST", "/prompt/answer", { answer: "Another answer for the same day." })).status).toBe(409);
    const ideas = (await (await u.call("GET", "/ideas")).json()) as { data: { reason: string }[] };
    expect(ideas.data[0]!.reason).toBe(`Your answer: ${p.question}`);
    expect(((await (await u.call("GET", "/prompt")).json()) as { answeredContextId: string }).answeredContextId).toBe(contextItemId);
  });
});

describe("uploads", () => {
  it("reads text files, keeps the original privately, and makes an idea", async () => {
    const u = await user("s2up1@example.com");
    const res = await u.upload(new Blob(["Notes from our launch: 40 people came, we demoed payments."], { type: "text/plain" }), "launch-notes.txt");
    expect(res.status).toBe(201);
    const out = (await res.json()) as { id: string; title: string; stored: boolean };
    expect(out).toMatchObject({ title: "launch-notes", stored: true });
    const row = await env.DB.prepare("SELECT kind, body, media_key FROM context_item WHERE id = ?").bind(out.id).first<{ kind: string; body: string; media_key: string }>();
    expect(row!.kind).toBe("document");
    expect(row!.media_key.startsWith(`orgs/${u.orgId}/uploads/`)).toBe(true);
    expect(await (await (env as unknown as { MEDIA: R2Bucket }).MEDIA.get(row!.media_key))!.text()).toContain("40 people came");
  });

  it("photos need a line about them when image reading isn't available; the type must match the bytes", async () => {
    const u = await user("s2up2@example.com");
    expect((await u.upload(new Blob([PNG], { type: "image/png" }), "a.png")).status).toBe(400); // no caption, no AI here
    expect((await u.upload(new Blob([PNG], { type: "image/png" }), "a.png", "Our whiteboard after the design sprint")).status).toBe(201);
    expect((await u.upload(new Blob(["not really a png"], { type: "image/png" }), "fake.png", "x")).status).toBe(415);
    expect((await u.upload(new Blob(["<svg onload=alert(1)>"], { type: "image/svg+xml" }), "x.svg", "x")).status).toBe(415);
    expect((await u.upload(new Blob(["%PDF-1.7 ..."], { type: "application/pdf" }), "deck.pdf")).status).toBe(503); // needs Workers AI
    expect((await u.upload(new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: "text/plain" }), "big.txt")).status).toBe(413);
  });

  it("viewers can't upload", async () => {
    const u = await user("s2up3@example.com");
    await env.DB.prepare("UPDATE membership SET role = 'viewer' WHERE org_id = ?").bind(u.orgId).run();
    expect((await u.upload(new Blob(["hello there, some notes"], { type: "text/plain" }), "n.txt")).status).toBe(403);
  });
});

describe("sources", () => {
  it("repairs an old 'feed' source that is really a web page", async () => {
    const u = await user("s2repair@example.com");
    const id = `src_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO source (id, org_id, kind, key) VALUES (?, ?, 'rss', 'https://ex.org/blog')").bind(id, u.orgId).run();
    const page = () => new Response(`<html><body><a href="/blog/one">One</a></body></html>`, { headers: { "Content-Type": "text/html" } });
    const post = () => new Response(`<html><head><title>One | Ex</title></head><body><article><p>${"A readable paragraph about something. ".repeat(4)}</p></article></body></html>`, { headers: { "Content-Type": "text/html" } });
    const fakeFetch = async (url: string) => (url === "https://ex.org/blog" ? page() : url === "https://ex.org/blog/one" ? post() : new Response("", { status: 404, headers: { "Content-Type": "text/html" } }));
    const db = createDb(env.DB);
    const src = await env.DB.prepare("SELECT * FROM source WHERE id = ?").bind(id).first();
    const out = await syncSource(db, { id, orgId: u.orgId, kind: "rss", key: "https://ex.org/blog", seen: [], lastCheckedAt: null, lastError: null, createdAt: new Date() }, { fetch: fakeFetch });
    expect(src).toBeTruthy();
    expect(out).toMatchObject({ added: 1, error: null });
    const row = await env.DB.prepare("SELECT kind, last_error FROM source WHERE id = ?").bind(id).first<{ kind: string; last_error: string | null }>();
    expect(row).toEqual({ kind: "page", last_error: null });
  });

  it("reads YouTube's feed descriptions", () => {
    const items = parseFeed(`<feed><entry><id>yt:video:1</id><title>Launch demo</title><link rel="alternate" href="https://www.youtube.com/watch?v=1"/><media:group><media:description>We show payments in 2 minutes.</media:description></media:group></entry></feed>`);
    expect(items[0]).toMatchObject({ title: "Launch demo", body: "We show payments in 2 minutes.", url: "https://www.youtube.com/watch?v=1" });
  });
});
