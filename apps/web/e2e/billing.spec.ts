// Plans: one person per plan, except the two Team plans (owner decision 2026-10-08).
import { expect, test } from "@playwright/test";
import { signUp } from "./helpers";

test("billing lists both Team plans; per-member Team prices by members", async ({ page }) => {
  await signUp(page);
  await page.goto("/app/billing");
  const card = page.locator("section", { has: page.getByRole("heading", { name: "Plan and billing" }) });
  await expect(card.getByText(/You're on/)).toContainText("Free");
  await expect(card.getByText("up to 5 people share Pro's allowance")).toBeVisible();
  const perMember = card.getByRole("row", { name: /Team \(per member\)/ });
  await expect(perMember).toContainText("$16/month ($8 per member)");
  await perMember.getByLabel("Members, monthly Team").selectOption("4");
  await expect(perMember).toContainText("$32/month ($8 per member)");
  await expect(card.getByRole("row", { name: /^Pro / })).toContainText("1 person");
});

test("a single-person plan explains how to add teammates", async ({ page }) => {
  await signUp(page);
  await page.goto("/app/team");
  await expect(page.getByText("Each plan is for one person. To work with others, switch to a Team plan in Billing.")).toBeVisible();
});
