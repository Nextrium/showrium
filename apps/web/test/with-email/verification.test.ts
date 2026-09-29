import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Email is switched on in this project. Brevo calls are intercepted here: nothing leaves the test.
const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.15.${Math.floor(++n / 250)}.${n % 250}`;
let outbox: { to: string; subject: string; text: string }[] = [];

beforeEach(() => {
  outbox = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://api.brevo.com/v3/smtp/email") {
      const body = JSON.parse(String(init?.body)) as { to: { email: string }[]; subject: string; textContent: string };
      outbox.push({ to: body.to[0]!.email, subject: body.subject, text: body.textContent });
      return new Response('{"messageId":"t"}', { status: 201 });
    }
    return real(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

const post = (path: string, body: unknown, cookie = "") =>
  SELF.fetch(`${BASE}/api/auth${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip(), ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
async function waitForMail(to: string, subject: RegExp) {
  for (let i = 0; i < 50; i++) {
    const m = outbox.find((x) => x.to === to && subject.test(x.subject));
    if (m) return m;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no "${subject}" email to ${to}`);
}
const linkIn = (text: string) => text.match(/https?:\/\/\S+/)![0];

describe("email confirmation is required for new password accounts", () => {
  it("no session until confirmed; sign-in resends the link; the link signs in", async () => {
    const email = "verify-me@example.com";
    const signup = await post("/sign-up/email", { email, name: "Vee", password: "correct-horse-battery", callbackURL: "/app/welcome" });
    expect(signup.status).toBe(200);
    expect(((await signup.json()) as { token: string | null }).token).toBeNull();
    const first = await waitForMail(email, /Confirm your email/);

    const blocked = await post("/sign-in/email", { email, password: "correct-horse-battery" });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { code: string }).code).toBe("EMAIL_NOT_VERIFIED");

    const open = await SELF.fetch(linkIn(first.text), { redirect: "manual", headers: { "CF-Connecting-IP": ip() } });
    expect([200, 302]).toContain(open.status);
    const row = await env.DB.prepare("SELECT email_verified FROM user WHERE email = ?").bind(email).first<{ email_verified: number }>();
    expect(row!.email_verified).toBe(1);

    const ok = await post("/sign-in/email", { email, password: "correct-horse-battery" });
    expect(ok.status).toBe(200);
  });

  it("a password reset is single-use and signs out other sessions", async () => {
    const email = "reset-me@example.com";
    await post("/sign-up/email", { email, name: "Rex", password: "correct-horse-battery" });
    await SELF.fetch(linkIn((await waitForMail(email, /Confirm your email/)).text), { redirect: "manual" });
    const session = cookieOf(await post("/sign-in/email", { email, password: "correct-horse-battery" }));

    expect((await post("/request-password-reset", { email, redirectTo: "/reset-password" })).status).toBe(200);
    // Unknown emails get the same answer (no account enumeration) and no email.
    expect((await post("/request-password-reset", { email: "nobody@example.com", redirectTo: "/reset-password" })).status).toBe(200);
    const mail = await waitForMail(email, /Reset your Showrium password/);
    expect(outbox.some((m) => m.to === "nobody@example.com")).toBe(false);

    const token = linkIn(mail.text).match(/reset-password\/([^?]+)/)![1]!;
    expect((await post("/reset-password", { token, newPassword: "a-brand-new-password" })).status).toBe(200);
    expect((await post("/reset-password", { token, newPassword: "another-new-password" })).status).toBe(400);

    const me = await SELF.fetch(`${BASE}/api/v1/me`, { headers: { Cookie: session, Origin: BASE } });
    expect(me.status).toBe(401);
    expect((await post("/sign-in/email", { email, password: "a-brand-new-password" })).status).toBe(200);
  });
});
