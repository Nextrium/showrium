import { parseSignupMode, type BillingConfig } from "@nextrium/core";

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
  /** Phase 3: token encryption key (32 bytes, base64) and platform app credentials (secrets). */
  TOKEN_ENCRYPTION_KEY?: string;
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
  LINKEDIN_CLIENT_ID?: string;
  LINKEDIN_CLIENT_SECRET?: string;
  TIKTOK_CLIENT_KEY?: string;
  TIKTOK_CLIENT_SECRET?: string;
  TIKTOK_SANDBOX_CLIENT_KEY?: string;
  TIKTOK_SANDBOX_CLIENT_SECRET?: string;
  /** "true" on preview: use the TikTok sandbox app. */
  TIKTOK_USE_SANDBOX?: string;
  /** Post images (R2, private). */
  MEDIA?: R2Bucket;
  /** Phase 4 premium video vendors (secrets; unset until contracts exist). */
  HEYGEN_API_KEY?: string;
  VEO_API_KEY?: string;
  /**
   * Phase 6 billing. Secrets: PAYSTACK_SECRET_KEY, LEMONSQUEEZY_API_KEY, LEMONSQUEEZY_WEBHOOK_SECRET.
   * Vars (not secret): product ids as JSON, e.g. PAYSTACK_PLANS = {"starter:month":"PLN_x"},
   * LEMONSQUEEZY_VARIANTS = {"starter:year":"123","credits:c500":"456"}; the NGN price of one USD.
   */
  /** Signs checkout custom data. Optional; falls back to BETTER_AUTH_SECRET. Do not rotate while payments are pending. */
  BILLING_SIGNING_SECRET?: string;
  PAYSTACK_SECRET_KEY?: string;
  PAYSTACK_PLANS?: string;
  PAYSTACK_NGN_PER_USD?: string;
  LEMONSQUEEZY_API_KEY?: string;
  LEMONSQUEEZY_WEBHOOK_SECRET?: string;
  LEMONSQUEEZY_STORE_ID?: string;
  LEMONSQUEEZY_VARIANTS?: string;
  /**
   * Incident kill switch (variable): "true" stops all posting through platform APIs (manual publish,
   * scheduled posts and autopilot). Tap-to-post still works: people post from their own apps.
   */
  PUBLISHING_PAUSED?: string;
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

export const publishingPaused = (env: Env) => env.PUBLISHING_PAUSED === "true";

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

function jsonMap(value: string | undefined): Record<string, string> {
  try {
    const parsed = JSON.parse(value ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string" || typeof e[1] === "number").map(([k, v]) => [k, String(v)]));
  } catch {
    return {};
  }
}

/** Billing configuration. A provider is enabled only when its secret and product ids are all present. */
export function billingConfig(env: Env): BillingConfig {
  const rate = Number(env.PAYSTACK_NGN_PER_USD ?? "");
  return {
    signingSecret: env.BILLING_SIGNING_SECRET || env.BETTER_AUTH_SECRET,
    returnUrl: `${env.BETTER_AUTH_URL}/app/settings?billing=done`,
    paystack: env.PAYSTACK_SECRET_KEY && rate > 0 ? { secretKey: env.PAYSTACK_SECRET_KEY, plans: jsonMap(env.PAYSTACK_PLANS), ngnPerUsd: rate } : undefined,
    lemonsqueezy:
      env.LEMONSQUEEZY_API_KEY && env.LEMONSQUEEZY_WEBHOOK_SECRET && env.LEMONSQUEEZY_STORE_ID
        ? { apiKey: env.LEMONSQUEEZY_API_KEY, webhookSecret: env.LEMONSQUEEZY_WEBHOOK_SECRET, storeId: env.LEMONSQUEEZY_STORE_ID, variants: jsonMap(env.LEMONSQUEEZY_VARIANTS) }
        : undefined,
  };
}
