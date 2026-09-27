import { Hono } from "hono";
import { api } from "./api.js";
import { createAuth } from "./auth.js";
import { apiError, type AppEnv } from "./principal.js";

const app = new Hono<AppEnv>();

app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));
app.route("/api/v1", api);
app.all("/api/*", (c) => c.json(apiError("not_found", "No such API route."), 404));

app.onError((err, c) => {
  console.error(err);
  return c.json(apiError("internal_error", "Something went wrong on our side. Please try again."), 500);
});

export default app;
