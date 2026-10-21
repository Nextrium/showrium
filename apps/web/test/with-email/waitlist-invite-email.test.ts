import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@nextrium/db";
import { inviteFromWaitlist, listWaitlist, sendEmail, waitlistInviteEmail } from "@nextrium/core";

// Email is on in this project; Brevo calls are intercepted here: nothing leaves the test.
// Staff send these from the admin app (apps/admin); here, the same core functions it uses.
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

describe("waitlist invite email", () => {
  it("emails a personal link, about their own Free workspace", async () => {
    await post("/api/v1/waitlist", { email: "kemi@wl-mail.test" });
    const db = createDb(env.DB);
    const entry = (await listWaitlist(db)).find((e) => e.email === "kemi@wl-mail.test")!;
    const [inv] = await inviteFromWaitlist(db, { entryIds: [entry.id], adminUserId: null });
    expect(inv).toMatchObject({ entryId: entry.id, email: "kemi@wl-mail.test" });
    const link = `${BASE}/invite?token=${encodeURIComponent(inv!.token)}`;
    expect(await sendEmail(env as unknown as { BREVO_API_KEY: string }, waitlistInviteEmail(inv!.email, link))).toEqual({ sent: true });
    const mail = outbox.find((m) => m.to === "kemi@wl-mail.test")!;
    expect(mail.subject).toBe("Your Showrium invite is here");
    expect(mail.text).toMatch(/your own Showrium account and workspace on the Free plan/);
    expect(mail.text).toMatch(new RegExp(`${BASE}/invite\\?token=inv_`));
    expect(mail.html).not.toMatch(/<script/i);
    // The link in the email works on the web app's invite page.
    expect((await post("/api/v1/invites/accept", { token: inv!.token })).status).toBe(200);
  });
});
