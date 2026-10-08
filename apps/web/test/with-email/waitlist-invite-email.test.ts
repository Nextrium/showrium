import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Email is on in this project; Brevo calls are intercepted here: nothing leaves the test.
const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.45.${Math.floor(++n / 250)}.${n % 250}`;
let outbox: { to: string; subject: string; text: string; html: string }[] = [];

beforeEach(() => {
  outbox = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://api.brevo.com/v3/smtp/email") {
      const body = JSON.parse(String(init?.body)) as { to: { email: string }[]; subject: string; textContent: string; htmlContent: string };
      outbox.push({ to: body.to[0]!.email, subject: body.subject, text: body.textContent, html: body.htmlContent });
      return new Response('{"messageId":"t"}', { status: 201 });
    }
    return real(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

const post = (path: string, body: unknown, cookie = "") =>
  SELF.fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip(), ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function adminSession() {
  await post("/api/auth/sign-up/email", { email: "admin@example.com", name: "Admin", password: "correct-horse-battery" });
  await env.DB.prepare("UPDATE user SET email_verified = 1 WHERE email = 'admin@example.com'").run();
  return cookieOf(await post("/api/auth/sign-in/email", { email: "admin@example.com", password: "correct-horse-battery" }));
}

describe("waitlist invite email", () => {
  it("emails a personal link (not shown to staff), about their own Free workspace", async () => {
    const admin = await adminSession();
    await post("/api/v1/waitlist", { email: "kemi@wl-mail.test" });
    const list = (await (await SELF.fetch(`${BASE}/api/v1/admin/waitlist`, { headers: { Cookie: admin, "CF-Connecting-IP": ip() } })).json()) as { data: { id: string; email: string }[] };
    const entry = list.data.find((e) => e.email === "kemi@wl-mail.test")!;
    const res = await post("/api/v1/admin/waitlist/invite", { ids: [entry.id] }, admin);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([{ id: entry.id, email: "kemi@wl-mail.test", sent: true, link: null }]);
    const mail = outbox.find((m) => m.to === "kemi@wl-mail.test")!;
    expect(mail.subject).toBe("Your Showrium invite is here");
    expect(mail.text).toMatch(/your own Showrium account and workspace on the Free plan/);
    expect(mail.text).toMatch(new RegExp(`${BASE}/invite\\?token=inv_`));
    expect(mail.html).not.toMatch(/<script/i);
  });
});
