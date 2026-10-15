// The flows people use every day, clicked through in a real browser. If one of these breaks, a
// release must not go out. The AI is the fake one (fixed replies), so these never cost money.
import { expect, test } from "@playwright/test";
import { composeOne, expectNoSidewaysScroll, png, signUp } from "./helpers";

const writeButton = (page: import("@playwright/test").Page) => page.getByRole("button", { name: /^Write \d+ posts?$/ });

test.describe("New post", () => {
  test("typed notes: the button says what's missing, then writes in one click", async ({ page }) => {
    await signUp(page);
    await page.goto("/app/new");
    await expect(writeButton(page)).toBeDisabled();
    await expect(page.getByText("Write or paste something first.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Use this" })).toHaveCount(0);
    await page.getByLabel("Your notes, update or idea").fill("Short");
    await expect(page.getByText("Write at least 10 characters.")).toBeVisible();
    await page.getByLabel("Your notes, update or idea").fill("We shipped retries with backoff for background jobs today.");
    await expect(writeButton(page)).toBeEnabled();
    await writeButton(page).click();
    await expect(page.getByRole("heading", { name: "Your drafts" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "LinkedIn post" })).toBeVisible();
    await expect(page.getByText(/^Using: We shipped retries/)).toBeVisible();
  });

  test("a link must be a full address; an earlier item can be picked instead", async ({ page }) => {
    await signUp(page);
    await composeOne(page);
    await page.goto("/app/new");
    await page.getByRole("tab", { name: "From a link" }).click();
    await page.getByLabel("Link to a blog post, article or page").fill("example");
    await expect(page.getByText("Enter a full link, starting with https://")).toBeVisible();
    await expect(writeButton(page)).toBeDisabled();
    await page.getByLabel("Or pick something you added before").selectOption({ index: 1 });
    await expect(writeButton(page)).toBeEnabled();
  });

  test("voice note: the transcript is shown to fix before anything is written", async ({ page }) => {
    await signUp(page);
    // The speech-to-text service isn't available locally: answer as it did for the owner's unclear recording.
    let sent: { hint?: string; save?: boolean } = {};
    await page.route("**/api/v1/contexts/voice", async (route) => {
      sent = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({ json: { text: "There is an ongoing ... ... ... ... ... and i did not think", unclear: "Much of the recording was unclear." } });
    });
    await page.goto("/app/new");
    await page.getByRole("tab", { name: "Voice note" }).click();
    await page.getByLabel("Names or words in your note (optional)").fill("LagosLife");
    await page.getByLabel("Or upload audio").setInputFiles({ name: "note.webm", mimeType: "audio/webm", buffer: Buffer.alloc(800, 1) });
    await expect(page.getByLabel("Your notes, update or idea")).toHaveValue(/There is an ongoing/);
    expect(sent).toMatchObject({ hint: "LagosLife", save: false });
    await expect(page.getByText(/Fix the text below/)).toBeVisible();
    await expect(writeButton(page)).toBeDisabled();
    await page.getByLabel("Your notes, update or idea").fill("LagosLife is a Nigerian browser game; its developer moved the live database twice.");
    await expect(writeButton(page)).toBeEnabled();
  });

  test("ask the AI with web research shows the sources and checked hints", async ({ page }) => {
    await signUp(page);
    await page.goto("/app/new");
    await page.getByRole("tab", { name: "Ask the AI" }).click();
    await expect(page.getByLabel("Let the AI choose")).toBeChecked();
    await expect(page.getByLabel("Instructions for the AI (optional)")).toHaveCount(0);
    await page.getByLabel("What should the post be about?").fill("Write an expert view on the Lagos Life game. Hints: she turned down a $100K offer.");
    await page.getByLabel("My view on someone else's work").check();
    await page.getByLabel(/Research the web for facts and sources/).check();
    await page.getByLabel("Bluesky", { exact: true }).uncheck();
    await writeButton(page).click();
    await expect(page.getByRole("heading", { name: "Your drafts" })).toBeVisible();
    await expect(page.getByText("Written as your view on someone else's work.")).toBeVisible();
    await expect(page.getByText("Sources found on the web (2)")).toBeVisible();
    await expect(page.getByRole("link", { name: /Lagos Life goes viral/ })).toHaveAttribute("href", "https://news.example/lagos-life");
    await expect(page.getByText("Found in a source")).toBeVisible();
    await expect(page.getByText("Not found: written as a claim")).toBeVisible();
  });
});

test.describe("A post", () => {
  test("edit, save, approve, add an image and post it myself", async ({ page }) => {
    await signUp(page);
    const id = await composeOne(page);
    await page.goto(`/app/posts?id=${id}`);
    const editor = page.getByRole("textbox", { name: "LinkedIn post" });
    await expect(editor).toBeVisible();
    const post = page.locator("section").filter({ has: editor });
    await editor.fill("Retries with backoff shipped today. Here is what changed and why it matters for background jobs.");
    await expect(post.getByRole("button", { name: "Approve" })).toBeDisabled();
    await post.getByRole("button", { name: "Save edits" }).click();
    await expect(post.getByRole("button", { name: "Save edits" })).toHaveCount(0);

    // An image, uploaded and shared by posts from the same material; then cropped from the original.
    await page.getByLabel("Upload photos for this post").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: png(1600, 1200) });
    await expect(page.getByText("Image 1 · Your photo")).toBeVisible();
    await page.getByRole("button", { name: "Crop to landscape" }).click();
    await expect(page.getByText("Cropped to landscape")).toBeVisible();
    await page.getByLabel("Image 1: description for screen readers").fill("A chart of retries");
    await page.getByRole("button", { name: "Save description" }).click();
    await expect(page.getByRole("button", { name: "Save description" })).toHaveCount(0);

    await post.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("The image for this post")).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save image 1" }).click();
    expect((await download).suggestedFilename()).toMatch(/^image-1\.(jpg|png)$/);

    // "Post it myself" opens the platform in a new tab; then mark it as posted.
    const popup = page.waitForEvent("popup");
    await page.getByRole("link", { name: "Post it myself (free)" }).click();
    await (await popup).close();
    await page.getByRole("button", { name: "I've posted it" }).click();
    await expect(page.getByText(/published/i).first()).toBeVisible();
  });
});

test.describe("Layout on a phone @phone", () => {
  test("new post and posts pages fit the screen @phone", async ({ page }) => {
    await signUp(page);
    const id = await composeOne(page);
    await page.goto("/app/new");
    await expect(writeButton(page)).toBeVisible();
    await expectNoSidewaysScroll(page);
    await page.goto(`/app/posts?id=${id}`);
    await expect(page.getByRole("textbox", { name: "LinkedIn post" })).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
});
