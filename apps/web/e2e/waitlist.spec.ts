// Staff invite someone from the waitlist; the invitee gets their own Free workspace.
import { expect, test } from "@playwright/test";
import { joinWaitlist, signInStaff } from "./helpers";

test("staff invite from the waitlist; the invitee joins their own Free workspace", async ({ page, browser }) => {
  const stamp = Date.now();
  const email = `wl-${stamp}@invitee.test`; // not allowlisted: can only join with an invite
  await joinWaitlist(page, email);
  await signInStaff(page);
  // Staff screens live in the admin app now (its own tests); here staff use the same API.
  type Entry = { id: string; email: string; status: string };
  const entryFor = async () => ((await (await page.request.get("/api/v1/admin/waitlist")).json()) as { data: Entry[] }).data.find((e) => e.email === email)!;
  const entry = await entryFor();
  expect(entry.status).toBe("waiting");
  const headers = { Origin: "http://localhost:5174", "Content-Type": "application/json" };
  expect((await page.request.post("/api/v1/admin/waitlist/invite", { headers, data: { ids: [] } })).status()).toBe(400); // an empty selection is refused
  // No email service locally: the link comes back to share by hand.
  const out = (await (await page.request.post("/api/v1/admin/waitlist/invite", { headers, data: { ids: [entry.id] } })).json()) as { data: { link: string | null }[] };
  expect((await entryFor()).status).toBe("invited");
  const url = new URL(out.data[0]!.link!);

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

  expect((await entryFor()).status).toBe("joined");
});
