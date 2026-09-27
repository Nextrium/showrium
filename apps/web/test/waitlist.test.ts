import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canSignUp, parseSignupMode } from "@nextrium/core";

const BASE = "http://localhost:5173";
let ipCounter = 0;
const ip = () => `10.3.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

function join(body: unknown, clientIp = ip()) {
  return SELF.fetch(`${BASE}/api/v1/waitlist`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": clientIp },
    body: JSON.stringify(body),
  });
}
async function rows(email: string) {
  const r = await env.DB.prepare("SELECT count(*) AS n FROM waitlist_entry WHERE email = ?").bind(email).first<{ n: number }>();
  return r?.n ?? 0;
}

describe("sign-up mode", () => {
  it("anything but 'allowlist' means waitlist (fail closed)", () => {
    expect(parseSignupMode("allowlist")).toBe("allowlist");
    for (const v of [undefined, "", "waitlist", "open", "ALLOWLIST", " allowlist"]) expect(parseSignupMode(v)).toBe("waitlist");
  });

  it("waitlist mode blocks every sign-up, even allowlisted or '*'", () => {
    expect(canSignUp("waitlist", "ada@example.com", "*")).toBe(false);
    expect(canSignUp("waitlist", "ada@example.com", "@example.com")).toBe(false);
  });

  it("allowlist mode follows the allowlist", () => {
    expect(canSignUp("allowlist", "ada@nextrium.org", "@nextrium.org")).toBe(true);
    expect(canSignUp("allowlist", "ada@gmail.com", "@nextrium.org")).toBe(false);
    expect(canSignUp("allowlist", "ada@nextrium.org", undefined)).toBe(false);
  });

  it("config reports the mode to the frontend", async () => {
    const config = (await (await SELF.fetch(`${BASE}/api/v1/config`)).json()) as { signupMode: string };
    expect(config.signupMode).toBe("allowlist");
  });
});

describe("waitlist", () => {
  it("stores a valid email, lowercased", async () => {
    const res = await join({ email: "New.Person@Example.com" });
    expect(res.status).toBe(202);
    expect(await rows("new.person@example.com")).toBe(1);
  });

  it("gives the same answer for a repeat email and keeps one row (no enumeration)", async () => {
    const first = await join({ email: "twice@example.com" });
    const second = await join({ email: "TWICE@example.com" });
    expect(second.status).toBe(first.status);
    expect(await second.json()).toEqual(await first.json());
    expect(await rows("twice@example.com")).toBe(1);
  });

  it("rejects invalid and oversized emails", async () => {
    for (const email of ["", "not-an-email", "a@", `${"x".repeat(250)}@example.com`]) {
      expect((await join({ email })).status).toBe(400);
    }
    expect((await join({})).status).toBe(400);
  });

  it("silently drops bot submissions that fill the honeypot", async () => {
    const res = await join({ email: "bot@example.com", website: "http://spam.example" });
    expect(res.status).toBe(202);
    expect(await rows("bot@example.com")).toBe(0);
  });

  it("rate-limits repeated submissions from one IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await join({ email: `burst${i}@example.com` }, "198.51.100.9")).status);
    expect(statuses.slice(0, 5).every((s) => s === 202)).toBe(true);
    expect(statuses).toContain(429);
  });
});
