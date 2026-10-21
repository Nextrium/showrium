// Staff invite someone from the waitlist; the invitee gets their own Free workspace.
import { expect, test } from "@playwright/test";
import { inviteFromWaitlistLocally, joinWaitlist, signInStaff, waitlistInvitedAt } from "./helpers";

test("staff invite from the waitlist; the invitee joins their own Free workspace", async ({ page, browser }) => {
  const stamp = Date.now();
  const email = `wl-${stamp}@invitee.test`; // not allowlisted: can only join with an invite
  await joinWaitlist(page, email);
  // Staff invite from the admin app (its own tests); here, the same invite is made in the local database.
  expect(waitlistInvitedAt(email)).toBeNull();
  const invitePath = inviteFromWaitlistLocally(email);
  expect(waitlistInvitedAt(email)).toBeGreaterThan(0);
  // The web app no longer has staff endpoints.
  await signInStaff(page);
  expect((await page.request.get("/api/v1/admin/waitlist")).status()).toBe(404);

  // The invitee, in their own browser.
  const guest = await browser.newContext();
  const g = await guest.newPage();
  await g.goto(invitePath);
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
});
