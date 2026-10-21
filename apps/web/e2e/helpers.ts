import { expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { DEV_VARS_PATH } from "./dev-vars";

const BASE = "http://localhost:5174";

/** A new signed-in account with its voice set up (through the API, as the app does). */
export async function signUp(page: Page, platforms = ["linkedin", "bluesky"]) {
  const email = `e2e-${randomUUID()}@example.com`;
  const password = `e2e-${randomUUID()}-Aa1!`;
  const headers = { Origin: BASE, "Content-Type": "application/json" };
  const res = await page.request.post("/api/auth/sign-up/email", { headers, data: { email, name: "E2E Tester", password } });
  expect(res.status(), await res.text()).toBe(200);
  const persona = await page.request.put("/api/v1/persona", { headers, data: { displayName: "E2E Tester", role: "Developer", platforms } });
  expect(persona.status()).toBe(200);
  return { email };
}

/** Writes a post through the API (fake AI) and returns its id. */
export async function composeOne(page: Page, platform = "linkedin") {
  const headers = { Origin: BASE, "Content-Type": "application/json" };
  const ctx = await (await page.request.post("/api/v1/contexts", { headers, data: { kind: "manual", body: "We shipped retries with backoff for background jobs today." } })).json();
  const out = await (await page.request.post("/api/v1/compose", { headers, data: { contextItemId: ctx.id, mode: "teach", platforms: [platform] } })).json();
  return out.drafts[0].id as string;
}

/** A real (decodable) PNG of the given size: a solid colour. */
export function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x5a)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** No sideways scrolling (layout fits the screen). */
export async function expectNoSidewaysScroll(page: Page) {
  const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll).toBeLessThanOrEqual(inner);
}

/** Signs in as the e2e staff account (created on first use; its password is in .dev.vars.e2e). */
export async function signInStaff(page: Page) {
  const vars = readFileSync(DEV_VARS_PATH, "utf8");
  const password = vars.match(/^E2E_STAFF_PASSWORD=(.+)$/m)?.[1]?.trim();
  if (!password) throw new Error("Delete apps/web/.dev.vars.e2e and run again (it predates the staff account).");
  const headers = { Origin: BASE, "Content-Type": "application/json" };
  const email = "staff-e2e@example.com";
  const up = await page.request.post("/api/auth/sign-up/email", { headers, data: { email, name: "Staff", password } });
  if (up.status() !== 200) expect((await page.request.post("/api/auth/sign-in/email", { headers, data: { email, password } })).status()).toBe(200);
  await page.request.put("/api/v1/persona", { headers, data: { displayName: "Staff", platforms: ["linkedin"] } });
}

/** Joins the public waitlist (as a visitor would). */
export async function joinWaitlist(page: Page, email: string) {
  const res = await page.request.post("/api/v1/waitlist", { headers: { Origin: BASE, "Content-Type": "application/json" }, data: { email } });
  expect(res.status()).toBeLessThan(300);
}

/** Runs SQL on the local e2e database (the same one the test server uses). Returns the rows. */
function localSql(sql: string): Record<string, unknown>[] {
  // From a file: on Windows the command goes through a shell, which would split inline SQL.
  const dir = mkdtempSync(join(tmpdir(), "showrium-e2e-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql);
  try {
    const out = execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--local", "--env", "e2e", "--json", `--file=${file}`], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      shell: process.platform === "win32",
      env: { ...process.env, CI: "true" },
    });
    const parsed = JSON.parse(out.slice(out.indexOf("["))) as { results: Record<string, unknown>[] }[];
    return parsed.flatMap((p) => p.results);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Invites a waitlisted email as staff do from the admin app (which has its own tests): a single-use
 * link, only its SHA-256 stored. Returns the invite link's path. Test-only; values are generated here.
 */
export function inviteFromWaitlistLocally(email: string) {
  if (!/^[a-z0-9.@-]+$/.test(email)) throw new Error("test emails only");
  const token = `inv_${btoa(String.fromCharCode(...randomBytes(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  const id = `inv_${randomUUID().replace(/-/g, "")}`;
  const now = Date.now();
  localSql(
    `INSERT INTO invite (id, token_hash, note, expires_at) VALUES ('${id}', '${hash}', 'Waitlist: ${email}', ${now + 7 * 24 * 60 * 60 * 1000});` +
      ` UPDATE waitlist_entry SET invited_at = ${now}, invite_id = '${id}' WHERE email = '${email}';`,
  );
  return `/invite?token=${encodeURIComponent(token)}`;
}

/** The waitlist entry for an email: when it was invited (ms), or null. */
export function waitlistInvitedAt(email: string) {
  if (!/^[a-z0-9.@-]+$/.test(email)) throw new Error("test emails only");
  return (localSql(`SELECT invited_at FROM waitlist_entry WHERE email = '${email}';`)[0]?.invited_at as number | null | undefined) ?? null;
}
