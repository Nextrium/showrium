# Changelog

## Unreleased

### For people
- **Clearer when X posting is down on our side:** if X stops accepting posts from Showrium for billing reasons, the post says it's on our side (not your account or your credits) and offers Post it myself. Nothing is charged.
- **Less text everywhere:** explanations on every page now sit behind a "?". A "?" now opens on tap as well as on hover.
- **Reconnecting an account keeps your scheduled posts:** posts waiting on an account you disconnected move to it when you connect it again, and still go out on time.
- **Fresher, cleaner ideas:** ideas are scored for how fresh and relevant they are. Old news, pre-releases, digests and days of only tidying are tucked away ("Show more" brings them back), and the same story from several sources becomes one idea. A new source brings in only its latest few items.
- **Automation picks well:** it writes only from good, fresh ideas, and "Approve for me" only approves strong ones from the last 48 hours. Approved posts are always scheduled ahead, never sent at once.
- **Check before it goes out:** you get an email listing what automation scheduled, and those posts are marked "Auto" in Posts with a **Cancel schedule** button.
- **No clashing posts:** schedule a post near another one on the same account and you're asked first: move the automated one, keep both, or pick another time. Your post always keeps its time.
- **X:** "Approve for me" now works on X too, after a one-time agreement (as X's rules ask). It only uses your plan's X posts, never credits.
- **Passions** can be approved by automation as well, with the same scheduling and email.
- **Your connection to a passion:** "I follow it", "I'm involved" or "It's ours". Posts are written to match: your view of someone else's work, your part in a project, or your own team ("we"). If a post about something you only follow sounds as if you're on its team, it's flagged for you to check.
- **The source link goes with the post:** at the end on LinkedIn, Facebook, Threads, Bluesky and Mastodon, and on X in the first reply (the post says so). It can be switched off per passion.
- **No more old news on a schedule:** news from your passions is never scheduled more than 48 hours after it came out (your own releases and posts: a week). If there's no free slot in time, the post is handed to you instead.
- **"Needs you" for time-sensitive posts:** when fresh news is worth posting but today's automated posts are used, it's written for you and flagged on Home and in Posts, with one email (at most 3 posts a day, never at night). Post it now, post it yourself, pick a time today, or skip it.
- **X posts with a link are always "Post it myself"** (free): they're never sent, scheduled or approved by the app, because X charges much more for links. X posts without a link can still be automated.
- **Easier X threads with "Post it myself":** paste the link to your first post and each reply opens X already replying to it, one click each. Your place is kept if you switch to the X app and back.
- **When a scheduled post fails,** you get an email with the platform's own reason (for example what X said), and the post shows it too, so you know what to fix.
- **Passions:** add the subjects you care about (a project, an ecosystem, a cause) and give each one its own sources: news sites, blogs, YouTube channels, podcasts or GitHub repositories. New items become ideas labelled with the passion, and posts are written as your view, never as its official voice. Switch a passion on or off, or give it dates. An optional disclosure (for example "I'm a Cardano ambassador") is added word for word to every post about it. Free: 1 passion with 3 sources; Lite 1 with 5; Starter 2; Creator 3; Pro and Team 10, with up to 10 sources each. Posts about a passion are never approved automatically.
- **Posts stay in your language:** the writer no longer switches language on its own.
- **Automation that posts at good times, not like clockwork:** choose your timezone, days and times of day (morning, midday, afternoon, evening). Each post goes out at a different minute, at most one per time of day and at least 4 hours apart, and Showrium learns which time works best for you.
- **Posts a day per platform**, within safe limits (X 5; Bluesky, Threads and Mastodon 3; LinkedIn and Facebook 2; Instagram, TikTok and YouTube Shorts 1).
- **No repeats:** new posts avoid how your recent posts began; a post that repeats a recent one is flagged and never approved automatically.
- **Style balance** replaces the weekly mix.
- **Less text:** explanations on the Automation page sit behind a "?".

### For Showrium staff
- **AI costs:** every AI call is recorded (posts, research, insights, images, video, voice), by day, feature, model and workspace, with the cost per post and the workspaces that cost more than they pay. Workers AI costs are marked as estimates.
- **Publishing health** warns at the top when our own X API account has run out of paid usage, so it can be topped up.
- The admin menu stays in place while a page scrolls.
- The product's old staff endpoints (`/api/v1/admin/*`) are removed; all of it is in the admin app.
- **Publishing health:** per platform, the reasons posts fail, accounts to reconnect, stuck or overdue posts, and whether the background jobs are keeping up.
- **Billing:** monthly revenue, subscriptions, past-due follow-ups, payment problems and credits (read-only).
- **Abuse:** workspaces worth a look, and a reversible **Pause/Resume** (owners only, with a reason, logged). A paused workspace keeps everything; its posting and automation simply wait.
- **Invite links in the admin app:** create a one-off link for someone who isn't on the waitlist (shown once), see each link's status, and revoke unused ones. Every action is logged.
- The old staff section in the product's Settings is gone; waitlist, invites and full access are in the admin app.

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
