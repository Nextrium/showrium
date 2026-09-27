# Showrium web app and API

One Cloudflare Worker serves both:
- **The web app** (`src/`, React): the static files are served free and don't count towards Worker request limits.
- **The API** (`worker/`, Hono):
  - `/api/v1/*`: the public REST API. The OpenAPI document is at `/api/v1/openapi.json`.
  - `/api/auth/*`: sign-in (Better Auth).

Data lives in Cloudflare D1. The schema and migrations are in `packages/db`, and business logic (credits ledger, API keys, workspaces) in `packages/core`.

## Local development

```bash
# once: local secret + local database
node -e "console.log('BETTER_AUTH_SECRET=' + require('crypto').randomBytes(32).toString('base64url'))" > .dev.vars
pnpm exec wrangler d1 migrations apply showrium-db --local

pnpm dev    # http://localhost:5173
pnpm test   # runs against a local D1 inside the Workers runtime
```

Email and password sign-in is enabled locally only. Password hashing needs more CPU than Cloudflare's free plan allows per request (10 ms), so production uses GitHub and Google sign-in.

## Deploying

Merging to `main` deploys automatically (see `.github/workflows/ci.yml`): D1 migrations are applied first, then the Worker.

To deploy by hand, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set:

```bash
pnpm exec wrangler d1 migrations apply showrium-db --remote --env production
CLOUDFLARE_ENV=production pnpm exec vite build && pnpm exec wrangler deploy
```

Production secrets are set with `wrangler secret put <NAME> --env production`:
- `BETTER_AUTH_SECRET`
- optional: `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`
- optional: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
