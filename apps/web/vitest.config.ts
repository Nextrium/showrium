import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("../../packages/db/migrations");
  const bindings = {
    TEST_MIGRATIONS: migrations,
    // Fresh random secret per run; never a fixed value in source.
    BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
    AUTH_PASSWORD_ENABLED: "true",
    SIGNUP_MODE: "allowlist",
    PLATFORM_ADMIN_EMAILS: "admin@example.com",
    // Deterministic AI stand-in (honoured only on localhost).
    LLM_MODE: "fake",
    TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
    // Only example.com is allowlisted in tests, so blocked sign-ups can be tested too.
    BETA_ALLOWED_EMAILS: "@example.com",
    // Billing test configuration: random secrets per run; product ids are fake.
    PAYSTACK_SECRET_KEY: "sk_test_" + crypto.randomUUID(),
    PAYSTACK_NGN_PER_USD: "1500",
    PAYSTACK_PLANS: JSON.stringify({ "starter:month": "PLN_starter", "lite:month": "PLN_lite" }),
    LEMONSQUEEZY_API_KEY: "ls_test_" + crypto.randomUUID(),
    LEMONSQUEEZY_WEBHOOK_SECRET: crypto.randomUUID(),
    LEMONSQUEEZY_STORE_ID: "1",
    LEMONSQUEEZY_VARIANTS: JSON.stringify({ "creator:year": "111", "starter:month": "333", "lite:month": "444", "credits:c500": "222", "team:month": "666", "team_seats:month:3": "555" }),
  };
  const shared = {
    setupFiles: ["./test/apply-migrations.ts"],
    // Integration tests sign up users and run whole flows; shared CI runners can exceed the 5 s default.
    testTimeout: 20_000,
  };
  return {
    test: {
      projects: [
        {
          plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings } })],
          test: { ...shared, name: "app", include: ["test/**/*.test.ts"], exclude: ["test/with-email/**"] },
        },
        {
          // Email switched on (a fake Brevo key; the test intercepts the request, nothing is sent).
          plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { ...bindings, BREVO_API_KEY: "test-" + crypto.randomUUID() } } })],
          test: { ...shared, name: "with-email", include: ["test/with-email/**/*.test.ts"] },
        },
      ],
    },
  };
});
