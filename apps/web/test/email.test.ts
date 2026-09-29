import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { actionEmail, sendEmail } from "../worker/email";
import type { Env } from "../worker/env";

const env = (extra: Partial<Env> = {}) => ({ ...extra }) as Env;
const mail = actionEmail({ to: "ada@example.com", name: "Ada <b>Lovelace</b>", subject: "Reset", intro: "Intro", button: "Go", url: "https://app.showrium.com/api/auth/reset-password/abc?callbackURL=%2Freset-password", outro: "Bye" });

describe("transactional email", () => {
  it("sends nothing without a key (sign-up and sign-in still work)", async () => {
    let called = false;
    const out = await sendEmail(env(), mail, async () => ((called = true), new Response("{}")));
    expect(out).toEqual({ sent: false });
    expect(called).toBe(false);
  });

  it("sends through Brevo from support@showrium.com by default", async () => {
    let req: { url: string; init: RequestInit } | null = null;
    const out = await sendEmail(env({ BREVO_API_KEY: "test-key" }), mail, async (url, init) => ((req = { url, init: init! }), new Response('{"messageId":"1"}', { status: 201 })));
    expect(out).toEqual({ sent: true });
    expect(req!.url).toBe("https://api.brevo.com/v3/smtp/email");
    expect((req!.init.headers as Record<string, string>)["api-key"]).toBe("test-key");
    const body = JSON.parse(String(req!.init.body)) as { sender: { email: string; name: string }; to: { email: string }[]; subject: string };
    expect(body.sender).toEqual({ email: "support@showrium.com", name: "Showrium" });
    expect(body.to[0]!.email).toBe("ada@example.com");
  });

  it("uses a configured sender, and reports provider errors without the key", async () => {
    let sender: unknown;
    await sendEmail(env({ BREVO_API_KEY: "k", EMAIL_FROM: "Showrium Team <hello@showrium.com>" }), mail, async (_u, init) => ((sender = JSON.parse(String(init!.body)).sender), new Response("{}", { status: 201 })));
    expect(sender).toEqual({ name: "Showrium Team", email: "hello@showrium.com" });
    await expect(sendEmail(env({ BREVO_API_KEY: "secret-key" }), mail, async () => new Response("bad", { status: 401 }))).rejects.toThrow(/^Email provider returned 401$/);
  });

  it("escapes names and links in the HTML", () => {
    expect(mail.html).not.toContain("<b>Lovelace");
    expect(mail.html).toContain("Hi Ada,");
    expect(mail.html).toContain("callbackURL=%2Freset-password");
    expect(mail.text).toContain("Go: https://app.showrium.com/api/auth/reset-password/abc");
  });

  it("hides password reset when email isn't configured", async () => {
    const config = (await (await SELF.fetch("http://localhost:5173/api/v1/config")).json()) as { auth: { password: boolean; passwordReset: boolean } };
    expect(config.auth).toMatchObject({ password: true, passwordReset: false });
  });
});
