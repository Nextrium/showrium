# Showrium

**One idea in, a post for every platform out, in your own voice.**

Showrium turns what you've built, written, photographed or said into posts made for each platform:
- LinkedIn
- X
- Instagram
- Facebook
- Threads
- TikTok
- YouTube Shorts
- Bluesky
- Mastodon

It writes in your voice, adds images and short videos, and publishes or schedules when you approve. It's for developers, founders, teachers and anyone who wants to share their work or make people smile. A public API does the same for other apps.

- Website: [showrium.com](https://showrium.com)
- App and API: [app.showrium.com](https://app.showrium.com)
- API reference: [`/api/docs`](https://app.showrium.com/api/docs)
- Licence: AGPL-3.0, or a commercial licence ([LICENSING.md](LICENSING.md))

> A Nextrium product. Showrium is open source; Nextrium's internal plans are kept in a separate private repository.

## What it does

- **Material in:** typed notes, links, voice notes, photos and documents, GitHub repositories, blogs and feeds, YouTube channels and podcasts, or a request to the AI (with optional web research that lists its sources).
- **Posts out:** one post per platform, in the right length and format. Threads where they fit. Up to 4 images, cropped per platform. Short explainer videos.
- **Publishing:** straight to LinkedIn, X, Bluesky and Mastodon. Anywhere else, "Post it myself" (text and images ready to paste). Scheduling, and automation you switch on per platform.
- **For teams and developers:** workspaces and roles, an audit log, plans and credits, a REST API, a TypeScript SDK and an MCP server.

Nothing posts without your approval unless you switch automation on. The AI never adds facts that aren't in your material, your request, or a source it found.

## How it's built

One **Cloudflare Worker** serves the React app and the API, with **D1** (SQLite) for data and **R2** for files.

```
apps/web                 the Worker: React 19 app (src/) + Hono API (worker/), tests (test/, e2e/)
apps/admin               the staff-only admin app (admin.showrium.com), behind Cloudflare Access
packages/core            business logic: workspaces, roles, content, images, publishing, billing, credits
packages/db              Drizzle schema and SQL migrations
packages/llm             prompts, the AI provider chain, web research
packages/platforms       platform adapters (LinkedIn, X, Bluesky, Mastodon, …)
packages/policy          platform rules and the post linter
packages/sdk-ts          TypeScript SDK, generated from the OpenAPI spec (Apache-2.0)
tools/cost-benchmark     measures AI cost per post
```

The other folders under `apps/` and `packages/` are reserved for later work and are empty for now.

**Admin app.** `apps/admin` is a separate Worker on the same database, for Showrium staff only:
- overview, waitlist invites, accounts and plans, staff, and an activity log
- Cloudflare Access signs staff in, and the Worker checks Access's signed token and the person's staff role on every request
- it offers no destructive operations
- locally, run `pnpm --filter @nextrium/admin dev` (port 5175) with `ADMIN_DEV_EMAIL` and `PLATFORM_ADMIN_EMAILS` set to the same address in `apps/admin/.dev.vars`

**AI.** Several providers are tried in order, so the app never depends on one:
- **Writing:** DeepSeek V4 Flash, then Gemini Flash-Lite (both through OpenRouter), then Cloudflare Workers AI.
- **Web research:** DeepSeek V4 Pro with Exa search, then Perplexity Sonar.
- **Cost:** a post costs a fraction of a cent, because the plans are $1–$10 a month.

## Run it locally

You need **Node 22** and **pnpm 10**.

```bash
git clone https://github.com/Nextrium/showrium.git
cd showrium
pnpm install
```

Create the local settings file, `apps/web/.dev.vars` (git-ignored; random values, never real secrets):

```bash
node -e "const c=require('crypto');require('fs').writeFileSync('apps/web/.dev.vars',['BETTER_AUTH_SECRET='+c.randomBytes(32).toString('base64url'),'TOKEN_ENCRYPTION_KEY='+c.randomBytes(32).toString('base64'),'AUTH_PASSWORD_ENABLED=true','SIGNUP_MODE=allowlist','BETA_ALLOWED_EMAILS=@example.com','LLM_MODE=fake',''].join('\n'))"
```

What these settings mean:
- **Sign-up:** you can create accounts with any `@example.com` email and a password.
- **Fake AI:** fixed replies, so no AI key is needed. For real writing, remove `LLM_MODE=fake` and add `OPENROUTER_API_KEY=…`.

Create the local database and start the app:

```bash
pnpm --filter @nextrium/web exec wrangler d1 migrations apply showrium-db --local
pnpm --filter @nextrium/web dev
```

Then open:

| Address | What |
|---|---|
| http://localhost:5173 | the website. Sign up at `/signin`; the app is at `/app` |
| http://localhost:5173/api/docs | the API reference |
| http://localhost:5173/api/v1/openapi.json | the API spec |

## Tests

```bash
pnpm typecheck
pnpm test                                    # server tests, run inside the real Workers runtime
pnpm --filter @nextrium/web e2e              # browser tests (Playwright) of the main flows
```

Before the first browser test run, install the browser once with `pnpm --filter @nextrium/web exec playwright install chromium`. The browser tests start their own server on port 5174, with a separate local database, the fake AI and random settings, so they never touch your data or cost money.

## Changing the database

1. Edit `packages/db/src/schema.ts`.
2. Run `pnpm --filter @nextrium/db generate`.
3. Commit the generated migration.

Changes may only **add** tables and columns. Migrations run before each deploy, while the previous version is still serving.

## Branches, CI and deploys

- **`develop`:** where work happens. It deploys to the preview site.
- **`main`:** the release. It deploys to production and only receives merges from `develop`.
- **CI runs:** lint, typecheck, tests, build, browser tests, CodeQL and a secret scan.
- **Deploys:** migrations, then the Worker, then a health check. A failing check stops the deploy.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Every contributor signs the [Contributor License Agreement](CLA.md) once, by replying to a bot on their first pull request.

**Found a security problem?** Please report it privately ([SECURITY.md](SECURITY.md)).

## Licence

- **The app:** the [GNU AGPL-3.0](LICENSE), or a commercial licence from Nextrium for uses the AGPL doesn't fit (legal@showrium.com).
- **The TypeScript SDK:** [Apache-2.0](packages/sdk-ts/LICENSE).
- **The name and logo** aren't covered by these licences ([TRADEMARKS.md](TRADEMARKS.md)).

See [LICENSING.md](LICENSING.md) for details.

© 2026 Nextrium.
