# Showrium

One context in, platform-native content out, for LinkedIn, X, Instagram, Facebook, Threads, TikTok, YouTube Shorts, Bluesky, Mastodon and Dev.to.

- **Consumer app** for anyone who wants to share their expertise, teach, or just make people smile.
- **One API** for developers and businesses.

> A Nextrium product. Internal plans and design docs live in the private `Nextrium/internal-docs` repo.

## Layout

| Path | What |
|---|---|
| `apps/` | web, api, worker, renderer, gpu, docs |
| `packages/` | db, core, llm, connectors, platforms, policy, media, billing, sdk-ts, ui |
| `infra/` | infrastructure as code |

## Development

Requires Node 22 and pnpm 10.

```bash
pnpm install
pnpm test
pnpm --filter @nextrium/web dev
```

- Live preview: https://showrium.abdulrahmanabdulbasit321.workers.dev
- API spec: `/api/v1/openapi.json`
- Setup details: [apps/web/README.md](apps/web/README.md)

Proprietary. © Nextrium. All rights reserved.
