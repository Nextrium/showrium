import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BASE = "http://localhost:5174";

/** A new signed-in account with its voice set up (through the API, as the app does). */
export async function signUp(page: Page, platforms = ["linkedin", "bluesky"]) {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = `e2e-${Math.random().toString(36).slice(2)}-Aa1!`;
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
  const vars = readFileSync(new URL("../.dev.vars.e2e", import.meta.url), "utf8");
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
