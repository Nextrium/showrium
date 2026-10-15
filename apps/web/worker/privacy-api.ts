// Privacy rights: download your workspace's data, and delete your account.
// Both need a signed-in person (not an API key): they're decisions a person makes.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { can, deleteAccount, exportWorkspace, PrivacyError, recordAudit } from "@nextrium/core";
import { apiError, requirePrincipal, type AppEnv } from "./principal.js";

export const privacyApi = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) return c.json(apiError("invalid_request", result.error.issues[0]?.message ?? "Invalid request."), 400);
  },
});
for (const path of ["/export", "/account/delete"]) privacyApi.use(path, requirePrincipal);

const Err = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const json = <T extends z.ZodType>(schema: T, description = "OK") => ({ description, content: { "application/json": { schema } } });

privacyApi.get("/export", async (c) => {
  const p = c.get("principal");
  if (p.kind !== "user") return c.json(apiError("forbidden", "Sign in to download your data."), 403);
  if (!can(p.role, "workspace.manage")) return c.json(apiError("forbidden", "Only owners and admins can download the workspace's data."), 403);
  const data = await exportWorkspace(c.get("db"), p.orgId, p.userId);
  await recordAudit(c.get("db"), { orgId: p.orgId, actorUserId: p.userId, action: "workspace.exported" });
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="showrium-export-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

privacyApi.openapi(
  createRoute({
    method: "post",
    path: "/account/delete",
    tags: ["Account"],
    request: { body: { required: true, content: { "application/json": { schema: z.object({ confirmEmail: z.string().max(254) }) } } } },
    responses: { 200: json(z.object({ workspacesDeleted: z.number(), filesDeleted: z.number() }), "Deleted"), 400: json(Err, "Not confirmed"), 403: json(Err, "Not allowed"), 409: json(Err, "Blocked") },
  }),
  async (c) => {
    const p = c.get("principal");
    if (p.kind !== "user") return c.json(apiError("forbidden", "Sign in to delete your account."), 403);
    try {
      const out = await deleteAccount(c.get("db"), c.env.MEDIA, { userId: p.userId, confirmEmail: c.req.valid("json").confirmEmail });
      console.info("account deleted", { workspaces: out.workspacesDeleted, files: out.filesDeleted });
      return c.json(out, 200);
    } catch (error) {
      if (error instanceof PrivacyError) return c.json(apiError(error.code, error.message), error.code === "confirm" ? 400 : error.code === "not_found" ? 403 : 409);
      throw error;
    }
  },
);
