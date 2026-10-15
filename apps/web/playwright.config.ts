// Browser smoke tests of the core flows (owner's rule: changes must not break what already works).
// They run against a local server on :5174 using the "e2e" Worker environment: its own local
// database and files, the fake AI, and random secrets per machine. Run with `pnpm e2e`.
import { defineConfig, devices } from "@playwright/test";
import { ensureDevVars } from "./e2e/dev-vars";

// Before anything else: the test server reads these when it starts (it starts before globalSetup).
ensureDevVars();

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:5174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, grepInvert: /@phone/ },
    { name: "phone", use: { ...devices["Pixel 7"] }, grep: /@phone/ },
  ],
  webServer: {
    command: "pnpm exec vite --port 5174 --strictPort",
    url: "http://localhost:5174",
    env: { CLOUDFLARE_ENV: "e2e" },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
