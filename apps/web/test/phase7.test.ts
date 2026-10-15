import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../worker/env";
import worker from "../worker/index";

const BASE = "http://localhost:5173";
const live = env as unknown as Env;
const paused: Env = { ...live, PUBLISHING_PAUSED: "true" };

async function signedIn(email: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": "10.10.0.1" },
    body: JSON.stringify({ email, name: "K", password: "correct-horse-battery" }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const me = (await (await SELF.fetch(`${BASE}/api/v1/me`, { headers: { Cookie: cookie } })).json()) as { workspace: { id: string } };
  return { cookie, orgId: me.workspace.id };
}

describe("health check", () => {
  it("reports the Worker and database are up, never cached, with security headers", async () => {
    const res = await SELF.fetch(`${BASE}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, publishingPaused: false });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});

describe("publishing kill switch", () => {
  it("refuses API publishing while paused", async () => {
    const u = await signedIn("p7pause@example.com");
    const req = new Request(`${BASE}/api/v1/drafts/drf_x/publish`, {
      method: "POST",
      headers: { Cookie: u.cookie, Origin: BASE, "Content-Type": "application/json", "CF-Connecting-IP": "10.10.0.2" },
      body: JSON.stringify({ connectionId: "cn_x" }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, paused, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("publishing_paused");
  });

  it("the cron leaves scheduled posts alone while paused, and runs again when resumed", async () => {
    const u = await signedIn("p7cron@example.com");
    await env.DB.prepare("INSERT INTO draft (id, org_id, platform, text, status, scheduled_at, connection_id) VALUES ('drf_p7', ?, 'bluesky', 'Hello', 'scheduled', ?, 'cn_missing')")
      .bind(u.orgId, Date.now() - 60_000)
      .run();
    const tick = async (e: Env) => {
      const ctx = createExecutionContext();
      await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, e, ctx);
      await waitOnExecutionContext(ctx);
      return (await env.DB.prepare("SELECT status FROM draft WHERE id = 'drf_p7'").first<{ status: string }>())!.status;
    };
    expect(await tick(paused)).toBe("scheduled");
    // Resumed: the runner picks it up (and fails it, since the account isn't connected).
    expect(await tick(live)).toBe("failed");
  });
});
