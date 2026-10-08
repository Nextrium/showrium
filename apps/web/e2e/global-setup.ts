// Prepares the local "e2e" environment: random secrets (never real ones) and an up-to-date local database.
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));

/** Values the local test server needs. Generated once per machine; none of them is a real credential. */
const NEEDED: Record<string, () => string> = {
  BETTER_AUTH_SECRET: () => `${randomUUID()}${randomUUID()}`,
  TOKEN_ENCRYPTION_KEY: () => btoa(String.fromCharCode(...randomBytes(32))),
  // Read by the tests (staff-e2e@example.com); not used by the Worker.
  E2E_STAFF_PASSWORD: () => randomUUID(),
  // Fake billing settings, so the Billing page lists plans. Checkout is never clicked in tests.
  LEMONSQUEEZY_API_KEY: () => "e2e-not-a-real-key",
  LEMONSQUEEZY_WEBHOOK_SECRET: () => randomUUID(),
};

export default function globalSetup() {
  const vars = `${web}.dev.vars.e2e`;
  if (!existsSync(vars)) writeFileSync(vars, "# Written by e2e/global-setup.ts for local browser tests. Random values; not real secrets.\n");
  const have = readFileSync(vars, "utf8");
  const missing = Object.entries(NEEDED).filter(([k]) => !new RegExp(`^${k}=`, "m").test(have));
  if (missing.length) appendFileSync(vars, `${have.endsWith("\n") ? "" : "\n"}${missing.map(([k, make]) => `${k}=${make()}\n`).join("")}`);
  execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--env", "e2e"], {
    cwd: web,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, CI: "true" }, // no confirmation prompt
  });
}
