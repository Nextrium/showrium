import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkTimeline, TimelineSchema, type Timeline } from "@nextrium/llm";
import { PlatformError, tiktokInboxUpload } from "@nextrium/platforms";
import { captionAt } from "../src/video/render";

const BASE = "http://localhost:5173";
const ORIGIN = { Origin: BASE };
let n = 0;
const ip = () => `10.7.${Math.floor(++n / 250)}.${n % 250}`;

async function withDraft(email: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ORIGIN, "CF-Connecting-IP": ip() },
    body: JSON.stringify({ email, name: "V", password: "correct-horse-battery" }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    SELF.fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: { Cookie: cookie, ...ORIGIN, "CF-Connecting-IP": ip(), ...(body !== undefined && typeof body !== "string" ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
  await call("PUT", "/persona", { displayName: "Ada", platforms: ["tiktok"] });
  const ctx = (await (await call("POST", "/contexts", { kind: "manual", body: "We shipped retries with backoff today." })).json()) as { id: string };
  const out = (await (await call("POST", "/compose", { contextItemId: ctx.id, mode: "teach", platforms: ["tiktok"] })).json()) as { drafts: { id: string }[] };
  const me = (await (await call("GET", "/me")).json()) as { workspace: { id: string } };
  return { call, draftId: out.drafts[0]!.id, orgId: me.workspace.id };
}

const base: Timeline = {
  title: "T",
  narration: "Short narration for the test video that fits.",
  aspect: "9:16",
  scenes: [
    { kind: "title", heading: "A", durationMs: 6000 },
    { kind: "text", body: "B", durationMs: 6000 },
    { kind: "outro", heading: "C", durationMs: 6000 },
  ],
};

describe("timeline rules", () => {
  it("accepts a sensible plan", () => expect(checkTimeline(base)).toBeNull());
  it("rejects too short, too long and over-narrated videos", () => {
    expect(checkTimeline({ ...base, scenes: base.scenes.map((s) => ({ ...s, durationMs: 2000 })) })).toMatch(/outside/);
    expect(checkTimeline({ ...base, scenes: [...base.scenes, ...base.scenes, ...base.scenes, ...base.scenes] })).toMatch(/outside/);
    expect(checkTimeline({ ...base, narration: "word ".repeat(80) })).toMatch(/too long/);
  });
  it("keeps code on screen", () => {
    const code = (c: string): Timeline => ({ ...base, scenes: [...base.scenes, { kind: "code", code: c, durationMs: 6000 }] });
    expect(checkTimeline(code("x".repeat(49)))).toMatch(/48/);
    expect(checkTimeline(code(Array(13).fill("x").join("\n")))).toMatch(/12 lines/);
  });
  it("schema refuses unknown scene kinds and absurd durations", () => {
    expect(TimelineSchema.safeParse({ ...base, scenes: [{ kind: "explosion", durationMs: 5000 }, ...base.scenes] }).success).toBe(false);
    expect(TimelineSchema.safeParse({ ...base, scenes: base.scenes.map((s) => ({ ...s, durationMs: 60_000 })) }).success).toBe(false);
  });
  it("captions walk through the narration in order", () => {
    const text = "one two three four five six seven eight nine ten eleven twelve";
    expect(captionAt(text, 0)).toBe("one two three four five six");
    expect(captionAt(text, 0.99)).toBe("seven eight nine ten eleven twelve");
    expect(captionAt("", 0.5)).toBe("");
  });
});

describe("videos API", () => {
  it("plans a video from a post, counts it, and revises by chat", async () => {
    const u = await withDraft("vid1@example.com");
    const res = await u.call("POST", "/videos", { draftId: u.draftId, aspect: "1:1" });
    expect(res.status).toBe(201);
    const v = (await res.json()) as { id: string; timeline: Timeline };
    expect(v.timeline.aspect).toBe("1:1");
    const usage = (await (await u.call("GET", "/usage")).json()) as { videos: { used: number } };
    expect(usage.videos.used).toBe(1);
    const revised = (await (await u.call("POST", `/videos/${v.id}/revise`, { instruction: "use a shorter title" })).json()) as { timeline: Timeline; revisions: number };
    expect(revised.timeline.title).toBe("Shorter");
    expect(revised.timeline.aspect).toBe("1:1"); // the aspect can't be changed by the model
    expect(revised.revisions).toBe(1);
  });

  it("needs exactly one source and caps revisions", async () => {
    const u = await withDraft("vid2@example.com");
    expect((await u.call("POST", "/videos", { aspect: "9:16" })).status).toBe(400);
    const v = (await (await u.call("POST", "/videos", { draftId: u.draftId })).json()) as { id: string };
    await env.DB.prepare("UPDATE video_project SET revisions = 20 WHERE id = ?").bind(v.id).run();
    expect((await u.call("POST", `/videos/${v.id}/revise`, { instruction: "again please" })).status).toBe(409);
  });

  it("charges credits past the plan and refuses when they run out", async () => {
    const u = await withDraft("vid3@example.com");
    const period = new Date().toISOString().slice(0, 7);
    await env.DB.prepare("UPDATE usage_counter SET videos_rendered = 2 WHERE org_id = ? AND period = ?").bind(u.orgId, period).run();
    expect((await u.call("POST", "/videos", { draftId: u.draftId })).status).toBe(201);
    const credits = (await (await u.call("GET", "/credits")).json()) as { balance: number };
    expect(credits.balance).toBe(18);
    await env.DB.prepare("INSERT INTO credit_txn (id, org_id, kind, idempotency_key, description) VALUES ('txn_v3', ?, 'spend', 'v3', 't')").bind(u.orgId).run();
    await env.DB.prepare("INSERT INTO credit_entry (id, txn_id, org_id, account, amount) VALUES ('ev3a','txn_v3',?,'org',-18),('ev3b','txn_v3',?,'platform',18)").bind(u.orgId, u.orgId).run();
    expect((await u.call("POST", "/videos", { draftId: u.draftId })).status).toBe(402);
  });

  it("keeps videos private to their workspace", async () => {
    const a = await withDraft("vid4a@example.com");
    const b = await withDraft("vid4b@example.com");
    const v = (await (await a.call("POST", "/videos", { draftId: a.draftId })).json()) as { id: string };
    expect((await b.call("GET", `/videos/${v.id}`)).status).toBe(404);
    expect((await b.call("POST", `/videos/${v.id}/revise`, { instruction: "hijack it" })).status).toBe(404);
    expect((await b.call("POST", "/videos", { draftId: a.draftId })).status).toBe(404);
  });

  it("voice-over reports clearly when unavailable; TikTok upload validates input", async () => {
    const u = await withDraft("vid5@example.com");
    const v = (await (await u.call("POST", "/videos", { draftId: u.draftId })).json()) as { id: string };
    expect((await u.call("POST", `/videos/${v.id}/voiceover`)).status).toBe(503);
    expect((await u.call("POST", `/videos/${v.id}/tiktok-inbox?connectionId=x`, "not a video", { "Content-Type": "text/plain" })).status).toBe(400);
    expect((await u.call("POST", `/videos/${v.id}/tiktok-inbox?connectionId=x`, "fakevideo", { "Content-Type": "video/webm" })).status).toBe(409);
  });
});

describe("TikTok inbox upload", () => {
  it("initialises then uploads the file in one chunk", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fake = async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.includes("/inbox/video/init/")) return Response.json({ data: { publish_id: "p1", upload_url: "https://upload.tiktok.example/u" }, error: { code: "ok" } });
      return new Response(null, { status: 201 });
    };
    const out = await tiktokInboxUpload({ accessToken: "t" }, "bytes", 5, "video/webm", fake);
    expect(out.publishId).toBe("p1");
    expect((calls[1]!.init!.headers as Record<string, string>)["Content-Range"]).toBe("bytes 0-4/5");
  });
  it("refuses oversized files and reports TikTok errors safely", async () => {
    await expect(tiktokInboxUpload({ accessToken: "t" }, "", 65 * 1024 * 1024, "video/mp4", fetch)).rejects.toBeInstanceOf(PlatformError);
    const refused = async () => Response.json({ error: { code: "scope_not_authorized" } });
    await expect(tiktokInboxUpload({ accessToken: "t" }, "b", 1, "video/mp4", refused)).rejects.toThrow(/didn't accept/);
  });
});
