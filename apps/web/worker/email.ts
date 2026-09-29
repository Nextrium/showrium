// Transactional email (password resets, email verification). Provider: Brevo (ADR: cheapest reliable
// option; switch by adding another branch here). With no key set, nothing is sent and the caller
// is told, so sign-up and sign-in still work.
import type { Env } from "./env.js";

export type Email = { to: string; toName?: string; subject: string; text: string; html: string };
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_FROM = { email: "support@showrium.com", name: "Showrium" };

export function emailConfigured(env: Env): boolean {
  return Boolean(env.BREVO_API_KEY);
}

function sender(env: Env) {
  const raw = env.EMAIL_FROM?.trim();
  const m = raw?.match(/^(.{1,80}?)\s*<([^<>\s]+@[^<>\s]+)>$/);
  if (m) return { name: m[1]!.trim(), email: m[2]! };
  if (raw && /^[^<>\s]+@[^<>\s]+$/.test(raw)) return { name: DEFAULT_FROM.name, email: raw };
  return DEFAULT_FROM;
}

/** Sends one email. Throws on provider errors (the message never includes the API key). */
export async function sendEmail(env: Env, email: Email, doFetch: FetchLike = fetch): Promise<{ sent: boolean }> {
  if (!env.BREVO_API_KEY) {
    console.warn(`email not configured; skipped "${email.subject}"`);
    return { sent: false };
  }
  const res = await doFetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      sender: sender(env),
      to: [{ email: email.to, ...(email.toName ? { name: email.toName.slice(0, 80) } : {}) }],
      subject: email.subject,
      textContent: email.text,
      htmlContent: email.html,
      tags: ["transactional"],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Email provider returned ${res.status}`);
  return { sent: true };
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A plain, accessible email with one button. Links are only ever ones we generated. */
export function actionEmail(input: { to: string; name?: string; subject: string; intro: string; button: string; url: string; outro: string }): Email {
  const hello = input.name ? `Hi ${input.name.split(" ")[0]},` : "Hi,";
  const text = [hello, "", input.intro, "", `${input.button}: ${input.url}`, "", input.outro, "", "Showrium, a Nextrium product · support@showrium.com"].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f6f5f2;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1c1b19">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
<p style="font-size:20px;font-weight:700;margin:0 0 24px">Showrium</p>
<div style="background:#fff;border:1px solid #e6e3dc;border-radius:14px;padding:24px">
<p style="margin:0 0 12px">${escape(hello)}</p>
<p style="margin:0 0 20px;line-height:1.5">${escape(input.intro)}</p>
<p style="margin:0 0 20px"><a href="${escape(input.url)}" style="display:inline-block;background:#f2b35a;color:#1c1b19;text-decoration:none;font-weight:600;padding:12px 18px;border-radius:10px">${escape(input.button)}</a></p>
<p style="margin:0 0 8px;font-size:13px;color:#6b675f;line-height:1.5">${escape(input.outro)}</p>
<p style="margin:0;font-size:12px;color:#8a857b;word-break:break-all">${escape(input.url)}</p>
</div>
<p style="font-size:12px;color:#8a857b;margin:20px 0 0">Showrium, a Nextrium product · support@showrium.com</p>
</div></body></html>`;
  return { to: input.to, ...(input.name ? { toName: input.name } : {}), subject: input.subject, text, html };
}
