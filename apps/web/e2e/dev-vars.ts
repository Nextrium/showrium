// The local test server's settings (.dev.vars.e2e, git-ignored). Written when the Playwright config
// loads, so they exist before the test server starts. Generated once per machine; none is a real credential.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DEV_VARS_PATH = fileURLToPath(new URL("../.dev.vars.e2e", import.meta.url));

const NEEDED: Record<string, () => string> = {
  BETTER_AUTH_SECRET: () => `${randomUUID()}${randomUUID()}`,
  TOKEN_ENCRYPTION_KEY: () => btoa(String.fromCharCode(...randomBytes(32))),
  // Read by the tests (staff-e2e@example.com); not used by the Worker.
  E2E_STAFF_PASSWORD: () => randomUUID(),
  // Fake billing settings, so the Billing page lists plans. Checkout is never clicked in tests.
  LEMONSQUEEZY_API_KEY: () => "e2e-not-a-real-key",
  LEMONSQUEEZY_WEBHOOK_SECRET: () => randomUUID(),
};

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** Adds any missing value (keeping existing ones, so accounts made in earlier runs still sign in). */
export function ensureDevVars() {
  const have = readOrEmpty(DEV_VARS_PATH);
  const missing = Object.entries(NEEDED).filter(([k]) => !new RegExp(`^${k}=`, "m").test(have));
  if (!missing.length) return;
  const head = have || "# Written by e2e/dev-vars.ts for local browser tests. Random values; not real secrets.\n";
  const lines = missing.map(([k, make]) => `${k}=${make()}\n`).join("");
  // One write of the whole file (mode 0600), never a check followed by a separate write.
  writeFileSync(DEV_VARS_PATH, `${head}${head.endsWith("\n") ? "" : "\n"}${lines}`, { mode: 0o600 });
}
