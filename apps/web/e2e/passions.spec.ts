// A passion's X accounts (several organisations) and topics, set in the page and kept after saving.
import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, signUp } from "./helpers";

const BASE = "http://localhost:5174";

test("a passion keeps several X accounts and its topics", async ({ page }) => {
  await signUp(page);
  const created = await page.request.post("/api/v1/passions", { headers: { Origin: BASE, "Content-Type": "application/json" }, data: { name: "AI and Machine Learning" } });
  expect(created.status()).toBe(201);
  await page.goto("/app/passions");
  await page.getByRole("button", { name: "Details" }).click();
  await page.locator('input[name="xHandles"]').fill("@LabOne, https://x.com/labtwo  @labone");
  await page.locator('input[name="topics"]').fill("LLM, model weights, inference");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Details" })).toBeVisible();

  // Opened again (and after a reload): cleaned, repeats dropped, in the order written.
  await page.reload();
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.locator('input[name="xHandles"]')).toHaveValue("@LabOne, @labtwo");
  await expect(page.locator('input[name="topics"]')).toHaveValue("LLM, model weights, inference");
  await expectNoSidewaysScroll(page);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });

  // A bad account is refused with a clear message, and nothing is saved.
  await page.locator('input[name="xHandles"]').fill("@LabOne, not a handle!");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/isn't an X account/)).toBeVisible();
});
