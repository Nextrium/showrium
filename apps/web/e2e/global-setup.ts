// Brings the local "e2e" database up to date. (Its settings are written by playwright.config.ts, see dev-vars.ts.)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));

export default function globalSetup() {
  execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--env", "e2e"], {
    cwd: web,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, CI: "true" }, // no confirmation prompt
  });
}
