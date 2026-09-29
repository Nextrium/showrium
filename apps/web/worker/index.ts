import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { api } from "./api.js";
import { mcp } from "./mcp.js";
import { createAuth } from "./auth.js";
import { publishingPaused } from "./env.js";
import { apiError, type AppEnv } from "./principal.js";
import { rateLimit } from "./rate-limit.js";
import { createDb } from "@nextrium/db";
import { expireSubscriptions, pruneExpiredOAuthStates, recoverStuckPublishing, runAutopilot, runDuePublishing, runEngagementSync, runSourcePolling } from "@nextrium/core";
import { aiProviders } from "./ai.js";
import { publishDeps } from "./connections-api.js";
import { imageDeps } from "./images-api.js";
import { autoImagesForBrief, type AfterCompose } from "@nextrium/core";
import type { Db } from "@nextrium/db";
import type { Env } from "./env.js";

/** Automation finds an image for the posts it writes, like people's own posts. */
function autoImages(env: Env, db: Db): AfterCompose | undefined {
  const deps = imageDeps(env, db);
  return deps ? (orgId, briefId) => autoImagesForBrief(deps, orgId, briefId) : undefined;
}

const app = new Hono<AppEnv>();

// Security headers on every Worker response (static assets get theirs from public/_headers).
app.use(
  "/api/*",
  secureHeaders({
    strictTransportSecurity: "max-age=31536000; includeSubDomains",
    xFrameOptions: "DENY",
    referrerPolicy: "strict-origin-when-cross-origin",
    crossOriginResourcePolicy: "same-origin",
  }),
);

// The API lives on the app domain. Calls that reach the website domain are sent there, except the
// two public endpoints the website itself uses (so it never needs cross-site requests or CORS).
const WEBSITE_API_PATHS = new Set(["/api/v1/config", "/api/v1/waitlist"]);
app.use("/api/*", async (c, next) => {
  const url = new URL(c.req.url);
  const appOrigin = new URL(c.env.BETTER_AUTH_URL).origin;
  if (url.origin !== appOrigin && url.origin === new URL(c.env.SITE_URL).origin && !WEBSITE_API_PATHS.has(url.pathname)) {
    return c.redirect(`${appOrigin}${url.pathname}${url.search}`, 308);
  }
  await next();
});

// Sign-in attempts: 10 per minute per IP. Other API calls: 120 per minute per IP.
app.post("/api/auth/*", rateLimit((env) => env.AUTH_LIMITER, "auth"));
app.use("/api/v1/*", rateLimit((env) => env.API_LIMITER, "api"));
app.use("/api/mcp", rateLimit((env) => env.API_LIMITER, "api"));
app.post("/api/v1/waitlist", rateLimit((env) => env.WAITLIST_LIMITER, "waitlist"));

// Readable API reference, rendered from the OpenAPI document by Scalar (CDN-hosted).
// This page shares the app origin, so the script is pinned with Subresource Integrity and
// the page gets its own CSP: a tampered CDN file is refused by the browser.
const SCALAR_VERSION = "1.72.1";
// SRI verified 2026-09-27: file SHA-256 matches jsDelivr's published hash for this version.
const SCALAR_SRI = "sha384-U11tb2XnKvmwt8RlTvnwUnYgrN+ur4Xyh9htLhjajWNR/Oyl5AX5DEz00qRmlrmK";
app.get("/api/docs", (c) => {
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https:; " +
      "font-src 'self' https: data:; img-src 'self' https: data:; connect-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  return c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Showrium API reference</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  </head>
  <body>
    <script id="api-reference" type="application/json" data-url="/api/v1/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/dist/browser/standalone.js"
      integrity="${SCALAR_SRI}" crossorigin="anonymous"></script>
  </body>
</html>`);
});

app.get("/api/health", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ ok: true, publishingPaused: publishingPaused(c.env) }, 200);
  } catch {
    return c.json({ ok: false }, 503);
  }
});

app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));
app.route("/api/v1", api);
app.route("/api/mcp", mcp);
app.all("/api/*", (c) => c.json(apiError("not_found", "No such API route."), 404));

app.onError((err, c) => {
  console.error(err);
  return c.json(apiError("internal_error", "Something went wrong on our side. Please try again."), 500);
});

// Two cron triggers, each its own invocation so each stays inside the free plan's per-invocation
// limits (50 D1 queries, 50 outbound requests):
//   "*/5 * * * *"      publishes due posts (at most 5 per run);
//   "2-59/5 * * * *"   runs one background job, taking turns.
export const PUBLISH_CRON = "*/5 * * * *";
const JOBS = ["sources", "autopilot", "engagement", "housekeeping"] as const;
export function cronJob(scheduledTime: number) {
  return JOBS[Math.floor(scheduledTime / 300_000) % JOBS.length]!;
}

async function scheduled(event: ScheduledController, env: AppEnv["Bindings"], ctx: ExecutionContext) {
  const db = createDb(env.DB);
  const now = new Date(event.scheduledTime);
  ctx.waitUntil(
    (async () => {
      const paused = publishingPaused(env);
      if (event.cron === PUBLISH_CRON) {
        if (!env.TOKEN_ENCRYPTION_KEY || paused) return;
        const result = await runDuePublishing(await publishDeps(env, db), now, 5);
        if (result.due) console.log("scheduled publishing", result);
        return;
      }
      const job = cronJob(event.scheduledTime);
      const result =
        job === "sources" ? await runSourcePolling(db, {}, now)
        : job === "autopilot" ? (paused ? { paused: true } : await runAutopilot(db, aiProviders(env), now, 1, autoImages(env, db)))
        : job === "engagement" ? await runEngagementSync(db, fetch, now)
        : { pruned: await pruneExpiredOAuthStates(db, now), recovered: await recoverStuckPublishing(db, now), expired: await expireSubscriptions(db, now) };
      console.log("cron", job, result);
    })(),
  );
}

export default { fetch: app.fetch, scheduled };
