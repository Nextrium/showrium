import { defineConfig } from "drizzle-kit";

// Generates SQL migrations only. Wrangler applies them to D1 (see apps/web/wrangler.jsonc).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./migrations",
});
