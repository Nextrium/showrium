# Changelog

## Unreleased

### For people
- **Automation that posts at good times, not like clockwork:** choose your timezone, days and times of day (morning, midday, afternoon, evening). Each post goes out at a different minute, at most one per time of day and at least 4 hours apart, and Showrium learns which time works best for you.
- **Posts a day per platform**, within safe limits (X 5; Bluesky, Threads and Mastodon 3; LinkedIn and Facebook 2; Instagram, TikTok and YouTube Shorts 1).
- **No repeats:** new posts avoid how your recent posts began; a post that repeats a recent one is flagged and never approved automatically.
- **Style balance** replaces the weekly mix.
- **Less text:** explanations on the Automation page sit behind a "?".

## v0.1.0: private beta (2026-10-15)

The first release of Showrium to app.showrium.com, for invited testers.

### Open source
- Showrium is open source under the **GNU AGPL-3.0**, with a **commercial licence** from Nextrium for uses the AGPL doesn't fit (LICENSING.md). The TypeScript SDK is **Apache-2.0**.
- Contributors sign a **Contributor License Agreement** once (CLA.md), checked automatically on pull requests.
- New: CONTRIBUTING.md, SECURITY.md (private vulnerability reports), TRADEMARKS.md, a "Source code" link in the site footer, and an "Open source" section in the Terms.

### For people
- **Write once, post everywhere:** one idea, link, photo, document or voice note becomes a post for each platform you use, in your voice. Nothing posts without your approval unless you switch it on.
- **Sources for everyone:**
  - public GitHub repositories
  - blogs and websites (with or without a feed)
  - YouTube channels and podcasts
  - photos and documents (iPhone photos included)
  - a daily question matched to your work
- **New post in one click:** type or paste, add a link, or record a voice note; "Write posts" saves it and writes in one step, and says what's missing if it can't yet.
- **Ask the AI:** tell it what to write (it follows your instructions), choose "about my own work" or "my view on someone else's work", and optionally let it research the web first. Every researched post lists its sources and which of your hints were confirmed.
- **Voice notes you can check:** names you type help the transcription; you see and edit the transcript before anything is written, and unclear recordings are flagged.
- **Ideas and Posts:** a list with a detail panel, and every post shows where it came from.
- **Threads and long posts:** "Write as a thread" for X, Bluesky, Threads and Mastodon, with each part editable. Long posts on X for Premium accounts.
- **Up to 4 images per post:**
  - your photos, the link's own image, a page screenshot, a designed card, or an AI image (always labelled)
  - shared by every post written from the same material, or different images for one post
  - cropped to the shape each platform shows best, from the original at full quality (the original is kept)
  - with a description for screen readers
  - "Post it myself" brings them along: share with images on phones, or copy and paste each image
- **Publishing:** post directly to Bluesky, Mastodon, LinkedIn and X (threads and images included), or tap-to-post anywhere else. Schedule posts, or approve a batch in one tap.
- **Automation you control:**
  - switches for each platform (write drafts, schedule when approved, approve for me)
  - a weekly mix of styles
  - posting days and time
- **Insights:** likes, replies and themes from your audience, where platforms allow it.
- **Video (early):** explainer videos with a voice-over and captions, made on your device.
- **Teams and billing:** workspaces, roles, invites, an audit log, plans (Paystack, Lemon Squeezy) and credits. Plans are for one person; Team (shared, up to 5 people at Pro's price) and Team (per member, 2 to 5) are for working together.
- **Waitlist invites:** staff invite people from the waitlist in one click; each gets their own Free workspace.
- **For developers:** a REST API with docs, a TypeScript SDK and an MCP server.
- **Design:** responsive from 320 px phones to wide screens, with light and dark themes.

### Accounts, security and privacy
- Sign in with Google, GitHub or email; email confirmation; password reset and change.
- Optional two-step sign-in with an authenticator app and backup codes. See and sign out your other devices.
- Download your data, or delete your account and its data yourself (Settings → Your data).
- Invite-only; showrium.com only collects the waitlist.
- House style: no hashtags, no em dashes, and numbers or handles not in your source are flagged.
- Rate limits, plan limits, private file storage, and a switch that pauses publishing in an emergency.
- Accessibility: WCAG 2.2 AA checks pass on every page, in both themes.
