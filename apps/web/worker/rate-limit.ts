// Edge rate limiting (Cloudflare Rate Limiting binding, free plan).
// Counters are per Cloudflare location and approximate: this slows abuse down, it isn't a hard quota.
// If the binding is missing or errors, requests are allowed. That's a documented fail-open,
// chosen so a limiter outage can't take the whole product down. Authorization never depends on it.
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./principal.js";

export type Limiter = Pick<RateLimit, "limit">;

export async function isRateLimited(limiter: Limiter | undefined, key: string): Promise<boolean> {
  if (!limiter) return false;
  try {
    const { success } = await limiter.limit({ key });
    return !success;
  } catch (error) {
    console.error("rate limiter unavailable; allowing request", error);
    return false;
  }
}

/** Client IP as seen by Cloudflare. Falls back to one shared bucket when absent (e.g. local tests). */
export function clientIp(headers: Headers): string {
  return headers.get("CF-Connecting-IP") ?? "unknown";
}

export function rateLimit(pick: (env: AppEnv["Bindings"]) => Limiter | undefined, scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (await isRateLimited(pick(c.env), `${scope}:${clientIp(c.req.raw.headers)}`)) {
      return c.json(
        { error: { code: "rate_limited", message: "Too many requests. Please wait a minute and try again." } },
        429,
        { "Retry-After": "60" },
      );
    }
    await next();
  };
}
