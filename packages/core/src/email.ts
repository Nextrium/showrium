// Transactional email (shared by the app and the admin app) (password resets, email verification). Provider: Brevo (ADR: cheapest reliable
// option; switch by adding another branch here). With no key set, nothing is sent and the caller
// is told, so sign-up and sign-in still work.
/** Only the email settings are needed (both apps' Worker environments fit). */
export type EmailEnv = { BREVO_API_KEY?: string | undefined; EMAIL_FROM?: string | undefined };

export type Email = { to: string; toName?: string; subject: string; text: string; html: string };
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_FROM = { email: "support@showrium.com", name: "Showrium" };

export function emailConfigured(env: EmailEnv): boolean {
  return Boolean(env.BREVO_API_KEY);
}

/**
 * A plain address check without regular expressions (no slow backtracking on odd input):
 * one "@", something on both sides, a dot in the domain, no spaces or angle brackets.
 */
export function looksLikeEmail(value: string): boolean {
  if (value.length > 254 || /[\s<>]/.test(value)) return false;
  const at = value.indexOf("@");
  if (at < 1 || at !== value.lastIndexOf("@")) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  return dot > 0 && dot < domain.length - 1;
}

/** `EMAIL_FROM` is "Name <address>" or just an address; anything else falls back to the default. */
function sender(env: EmailEnv) {
  const raw = env.EMAIL_FROM?.trim();
  if (!raw) return DEFAULT_FROM;
  const open = raw.lastIndexOf("<");
  if (open >= 0 && raw.endsWith(">")) {
    const name = raw.slice(0, open).trim();
    const email = raw.slice(open + 1, -1);
    if (name && name.length <= 80 && looksLikeEmail(email)) return { name, email };
    return DEFAULT_FROM;
  }
  return looksLikeEmail(raw) ? { name: DEFAULT_FROM.name, email: raw } : DEFAULT_FROM;
}

/** Sends one email. Throws on provider errors (the message never includes the API key). */
export async function sendEmail(env: EmailEnv, email: Email, doFetch: FetchLike = fetch): Promise<{ sent: boolean }> {
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
<p style="margin:0 0 20px;line-height:1.5;white-space:pre-line">${escape(input.intro)}</p>
<p style="margin:0 0 20px"><a href="${escape(input.url)}" style="display:inline-block;background:#f2b35a;color:#1c1b19;text-decoration:none;font-weight:600;padding:12px 18px;border-radius:10px">${escape(input.button)}</a></p>
<p style="margin:0 0 8px;font-size:13px;color:#6b675f;line-height:1.5">${escape(input.outro)}</p>
<p style="margin:0;font-size:12px;color:#8a857b;word-break:break-all">${escape(input.url)}</p>
</div>
<p style="font-size:12px;color:#8a857b;margin:20px 0 0">Showrium, a Nextrium product · support@showrium.com</p>
</div></body></html>`;
  return { to: input.to, ...(input.name ? { toName: input.name } : {}), subject: input.subject, text, html };
}

/** The invite for someone on the waitlist: their own account and workspace, on the Free plan. */
export function waitlistInviteEmail(to: string, link: string): Email {
  return actionEmail({
    to,
    subject: "Your Showrium invite is here",
    intro: "Thanks for joining the Showrium waitlist. Your invite is ready: it creates your own Showrium account and workspace on the Free plan. You can upgrade any time.",
    button: "Create my account",
    url: link,
    outro: "This link works once, for 7 days. If you didn't ask to join, you can ignore this email.",
  });
}

/** The invite for a new staff member. */
export function staffInviteEmail(to: string, link: string, role: string): Email {
  return actionEmail({
    to,
    subject: "You're invited to the Showrium team",
    intro: `You've been added to the Showrium admin team (${role}). Create your account with this link, using this email address, then open the admin app.`,
    button: "Create my account",
    url: link,
    outro: "This link works once, for 7 days. If you weren't expecting this, you can ignore this email.",
  });
}
