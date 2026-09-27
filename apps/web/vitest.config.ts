import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import crypto from "node:crypto";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("../../packages/db/migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Fresh random secret per run; never a fixed value in source.
            BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
            AUTH_PASSWORD_ENABLED: "true",
            SIGNUP_MODE: "allowlist",
            // Only example.com is allowlisted in tests, so blocked sign-ups can be tested too.
            BETA_ALLOWED_EMAILS: "@example.com",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
