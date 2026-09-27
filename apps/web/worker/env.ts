import { parseSignupMode } from "@nextrium/core";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Origin of the product (sign-in, dashboard, API): https://app.showrium.com in production. */
  BETTER_AUTH_URL: string;
  /** Origin of the public website: https://showrium.com in production. */
  SITE_URL: string;
  BETTER_AUTH_SECRET: string;
  AUTH_PASSWORD_ENABLED?: string;
  /** "waitlist" (nobody can self sign-up) or "allowlist". Anything else means waitlist. */
  SIGNUP_MODE?: string;
  WAITLIST_LIMITER?: RateLimit;
  /** AI: OpenRouter key (secret) and the Workers AI binding (deployed environments only). */
  OPENROUTER_API_KEY?: string;
  AI?: Ai;
  /** "fake" enables a deterministic AI stand-in, honoured only on localhost (tests, local dev). */
  LLM_MODE?: string;
  /** Optional GitHub token to raise the API rate limit for public repo sources. */
  GITHUB_TOKEN?: string;
  /** Platform admins (secret): exact emails allowed to create invites. Unset = nobody. */
  PLATFORM_ADMIN_EMAILS?: string;
  /** Beta sign-up allowlist (secret): emails, "@domain" entries or "*". Unset = no new sign-ups. */
  BETA_ALLOWED_EMAILS?: string;
  /** Cloudflare rate limiters. Optional so a missing binding degrades to "allow" (documented fail-open). */
  AUTH_LIMITER?: RateLimit;
  API_LIMITER?: RateLimit;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

export function signupMode(env: Env) {
  return parseSignupMode(env.SIGNUP_MODE);
}

export function authProviders(env: Env) {
  return {
    password: env.AUTH_PASSWORD_ENABLED === "true",
    github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  };
}
