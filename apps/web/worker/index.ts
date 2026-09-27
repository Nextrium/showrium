import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { api } from "./api.js";
import { createAuth } from "./auth.js";
import { apiError, type AppEnv } from "./principal.js";
import { rateLimit } from "./rate-limit.js";

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

// The API lives on the app domain only. Calls that reach the website domain are sent there.
app.use("/api/*", async (c, next) => {
  const url = new URL(c.req.url);
  const appOrigin = new URL(c.env.BETTER_AUTH_URL).origin;
  if (url.origin !== appOrigin && url.origin === new URL(c.env.SITE_URL).origin) {
    return c.redirect(`${appOrigin}${url.pathname}${url.search}`, 308);
  }
  await next();
});

// Sign-in attempts: 10 per minute per IP. Other API calls: 120 per minute per IP.
app.post("/api/auth/*", rateLimit((env) => env.AUTH_LIMITER, "auth"));
app.use("/api/v1/*", rateLimit((env) => env.API_LIMITER, "api"));

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

app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));
app.route("/api/v1", api);
app.all("/api/*", (c) => c.json(apiError("not_found", "No such API route."), 404));

app.onError((err, c) => {
  console.error(err);
  return c.json(apiError("internal_error", "Something went wrong on our side. Please try again."), 500);
});

export default app;
