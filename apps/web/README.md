# Showrium web app and API

One Cloudflare Worker serves both:
- **The web app** (`src/`, React): the static files are served free and don't count towards Worker request limits.
- **The API** (`worker/`, Hono):
  - `/api/v1/*`: the public REST API. The OpenAPI document is at `/api/v1/openapi.json`.
  - `/api/auth/*`: sign-in (Better Auth).

Data lives in Cloudflare D1. The schema and migrations are in `packages/db`, and business logic (credits ledger, API keys, workspaces) in `packages/core`.

## Local development

First set up `.dev.vars` and the local database as described in "Run it locally" in the [main README](../../README.md). Then:

```bash
pnpm dev    # http://localhost:5173
pnpm test   # server tests, against a local D1 inside the Workers runtime
pnpm e2e    # browser tests (Playwright), on their own server at :5174
```

Email and password sign-in is on locally, on preview and in production. GitHub and Google sign-in are optional.

## Deploying

CI deploys automatically (see `.github/workflows/ci.yml`), after all checks pass:
- **`develop`** deploys to preview (preview.showrium.com, its own Worker, database `showrium-db-preview` and settings).
- **`main`** deploys to production (app.showrium.com, database `showrium-db`).

Each deploy applies the D1 migrations first, then deploys the Worker, then checks `/api/v1/health`. The admin app deploys in the same run.

## Settings

Secrets are set per environment with `wrangler secret put <NAME> --env preview|production`. Never commit them, and never paste them into issues or chat.

| Group | Names |
|---|---|
| Required | `BETTER_AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY` |
| AI | `OPENROUTER_API_KEY` (writing and research); `LLM_MODE=fake` for local work |
| Sign-in | `GITHUB_CLIENT_ID`/`_SECRET`, `GOOGLE_CLIENT_ID`/`_SECRET` |
| Platforms | `X_CLIENT_ID`/`_SECRET`, `LINKEDIN_CLIENT_ID`/`_SECRET`, `TIKTOK_CLIENT_KEY`/`_SECRET` (plus the `TIKTOK_SANDBOX_*` pair and `TIKTOK_USE_SANDBOX`) |
| Email | `BREVO_API_KEY`, `EMAIL_FROM` |
| Billing | `PAYSTACK_SECRET_KEY`, `PAYSTACK_PLANS`, `PAYSTACK_NGN_PER_USD`, `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_VARIANTS`, `LEMONSQUEEZY_WEBHOOK_SECRET`, `BILLING_SIGNING_SECRET` |
| Optional | `BROWSER_RENDERING_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (page screenshots), `GITHUB_TOKEN` (higher GitHub limits), `HEYGEN_API_KEY`, `VEO_API_KEY` |
| Access | `SIGNUP_MODE`, `BETA_ALLOWED_EMAILS`, `AUTH_PASSWORD_ENABLED`, `PLATFORM_ADMIN_EMAILS` |
| Emergency | `PUBLISHING_PAUSED=true` stops all posting through platform APIs |
