import { Hono } from "hono";
import { api } from "./api.js";
import { createAuth } from "./auth.js";
import { apiError, type AppEnv } from "./principal.js";

const app = new Hono<AppEnv>();

// The API lives on the app domain only. Calls that reach the website domain are sent there.
app.use("/api/*", async (c, next) => {
  const url = new URL(c.req.url);
  const appOrigin = new URL(c.env.BETTER_AUTH_URL).origin;
  if (url.origin !== appOrigin && url.origin === new URL(c.env.SITE_URL).origin) {
    return c.redirect(`${appOrigin}${url.pathname}${url.search}`, 308);
  }
  await next();
});

// Readable API reference for developers, rendered from the OpenAPI document (Scalar, free, CDN-hosted).
const SCALAR_VERSION = "1.72.1";
app.get("/api/docs", (c) =>
  c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Showrium API reference</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  </head>
  <body>
    <script id="api-reference" data-url="/api/v1/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/dist/browser/standalone.js"></script>
  </body>
</html>`),
);

app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));
app.route("/api/v1", api);
app.all("/api/*", (c) => c.json(apiError("not_found", "No such API route."), 404));

app.onError((err, c) => {
  console.error(err);
  return c.json(apiError("internal_error", "Something went wrong on our side. Please try again."), 500);
});

export default app;
