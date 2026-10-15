// Staff invite people from the waitlist in one click; an invitee gets their own Free workspace.
import { expect, test } from "@playwright/test";
import { joinWaitlist, signInStaff } from "./helpers";

test("staff invite from the waitlist; the invitee joins their own Free workspace", async ({ page, browser }) => {
  const stamp = Date.now();
  const email = `wl-${stamp}@invitee.test`; // not allowlisted: can only join with an invite
  await joinWaitlist(page, email);
  await signInStaff(page);
  await page.goto("/app/settings");
  const card = page.locator("section", { has: page.getByRole("heading", { name: "Waitlist" }) });
  const rows = card.getByRole("list", { name: "Waitlist" });
  await expect(rows.getByText(email)).toBeVisible();
  await card.getByRole("button", { name: `Invite ${email}` }).click();
  // No email service locally: the link is shown to share by hand.
  await expect(card.getByText(/couldn't be emailed: share these links yourself/)).toBeVisible();
  await card.getByRole("button", { name: /^Invited \(/ }).click();
  await expect(rows.getByText(email)).toBeVisible();
  const link = await page.evaluate(async (e) => {
    const res = await fetch("/api/v1/admin/waitlist/invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [] }) });
    return [res.status, e];
  }, email);
  expect(link[0]).toBe(400); // an empty selection is refused

  // Get a fresh link the way staff would see it (invite again replaces the first).
  const again = page.waitForResponse("**/api/v1/admin/waitlist/invite");
  await card.getByRole("button", { name: `Invite again ${email}` }).click();
  const out = (await (await again).json()) as { data: { link: string }[] };
  const url = new URL(out.data[0]!.link);

  // The invitee, in their own browser.
  const guest = await browser.newContext();
  const g = await guest.newPage();
  await g.goto(`${url.pathname}${url.search}`);
  await expect(g.getByText(/your own Showrium account and workspace on the Free plan/)).toBeVisible();
  await g.getByLabel("Your name").fill("Invitee");
  await g.getByLabel("Email").fill(email);
  await g.getByLabel("Password (at least 10 characters)").fill(`pw-${stamp}-secure`);
  await g.getByRole("button", { name: "Create my account" }).click();
  await g.waitForURL("**/app/welcome");
  const me = (await (await g.request.get("/api/v1/me")).json()) as { workspace: { plan: string; name: string }; principal: { role: string } };
  expect(me.workspace.plan).toBe("free");
  expect(me.principal.role).toBe("owner");
  await guest.close();

  await page.reload();
  await card.getByRole("button", { name: /^Joined \(/ }).click();
  await expect(rows.getByText(email)).toBeVisible();
});
