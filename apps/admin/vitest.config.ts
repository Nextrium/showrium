import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
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
            // Not localhost, so the local sign-in shortcut is off and Access tokens are required.
            ADMIN_URL: "https://admin.test",
            APP_URL: "https://app.test",
            ACCESS_TEAM_DOMAIN: "team.test.cloudflareaccess.com",
            ACCESS_AUD: "test-aud",
            PLATFORM_ADMIN_EMAILS: "owner@example.com",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"], testTimeout: 20_000 },
  };
});
