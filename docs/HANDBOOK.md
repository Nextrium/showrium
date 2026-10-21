# Showrium contributor handbook

The shared context for everyone who works on Showrium: what it is, how work moves from an idea to a release, the standards every change meets, and the checks that run before anything is pushed.

Start here, then read [CONTRIBUTING.md](../CONTRIBUTING.md) for the pull-request basics and the [README](../README.md) to run the app.

## 1. What Showrium is

Showrium turns what people build, write, photograph or say into posts made for each social platform, in their own voice. It writes, adds images and short videos, and publishes or schedules when the person approves.

**Who it's for:** developers, founders, teachers, ecosystem contributors and anyone with work worth sharing who doesn't post, usually for lack of time, ideas or confidence.

**What it promises:**
- **Nothing posts without approval** unless the person switches automation on, per platform.
- **No invented facts.** Posts use only the person's material, their request, or sources a search found.
- **Every platform's rules are followed.** Official APIs only, never scraping. AI content is labelled where a platform asks. Automation never replies, mentions, likes or messages.
- **Affordable:** plans from $1 to $10 a month, so every feature is designed to cost very little to run.
- **Global, Africa included:** local payments and prices, and phones first.

**Where it stands:** a private beta at [app.showrium.com](https://app.showrium.com). Work happens on `develop`, which runs at preview.showrium.com. The company roadmap tracks every phase to public launch; each task in this repository belongs to one of its items.

## 2. How the code is organised

One Cloudflare Worker serves the React app and the API. D1 (SQLite) holds the data and R2 holds the files.

| Folder | What it holds |
|---|---|
| `apps/web` | The product: the React app (`src/`), the Hono API (`worker/`), server tests (`test/`), browser tests (`e2e/`) |
| `apps/admin` | The staff admin app, a separate Worker behind Cloudflare Access |
| `packages/core` | Business logic: workspaces, content, ideas, automation, publishing, billing, costs |
| `packages/db` | The Drizzle schema and SQL migrations |
| `packages/llm` | Prompts, the AI provider chain, web research |
| `packages/platforms` | One adapter per social platform |
| `packages/policy` | Platform limits and the post linter |
| `packages/sdk-ts` | The TypeScript SDK (Apache-2.0) |

Folders not listed here (`apps/docs`, `apps/gpu`, `apps/renderer`, `apps/worker`, `packages/billing`, `packages/connectors`, `packages/media`, `packages/ui`) are reserved for later work and hold no code yet.

## 3. How work flows

1. **Roadmap item.** Every piece of work belongs to an item on the company roadmap, in one of its phases.
2. **Task.** Open a GitHub issue with the **Task** template: the roadmap phase, the team, what "done" means, and how it will be tested. Big changes agree the approach in the issue first.
3. **Branch.** Branch from `develop`. Never commit to `main`.
4. **Build and check.** Write the change with its tests, then run the checks in section 5 until they all pass.
5. **Pull request into `develop`.** Fill in the template. A maintainer reviews it.
6. **Preview.** Merging into `develop` deploys to preview.showrium.com: migrations first, then the app, then a health check. Check the change there.
7. **Release.** A release merges `develop` into `main` (a merge commit), which deploys to production. Releases need the roadmap gate for that phase to be met.
8. **Close the loop.** Mark the roadmap item done, and add a line to `CHANGELOG.md` under "Unreleased" in plain words.

## 4. Standards

### Security and privacy

- **Workspaces stay apart.** Every query is filtered by the workspace (`org_id`) from the signed-in session or API key, never from the request body. Test that another workspace can't read or change new data.
- **Check the permission in every action** with `can(role, …)`. Being signed in isn't enough.
- **Fail closed.** Errors, unknown roles and missing settings deny access.
- **Validate input** with Zod at the API boundary, and document every endpoint in the OpenAPI schemas.
- **No secrets anywhere:** not in code, tests, logs, commits or issues. Local values live in `.dev.vars` files, which git ignores. Tokens are stored encrypted.
- **Text from outside is data, never instructions.** Feeds, links, web pages and AI output stay inside their prompt tags.
- **Platform rules come first:** official APIs only, never scraping; no automated replies, mentions, likes or messages; respect each platform's posting limits.
- Report security problems privately ([SECURITY.md](../SECURITY.md)), never in a public issue.

### Data

- **Migrations only add.** Edit `packages/db/src/schema.ts`, run `pnpm --filter @nextrium/db generate`, and commit the generated migration. Never drop or rename a column that's in use: migrations run before the new version deploys.
- **Inserts stay under D1's 100-variable limit.** Batch multi-row inserts with `chunkRows(rows, <values per row>)`, and update the number when you add columns.
- **Nothing is deleted without the person asking.** Prefer reversible states (set aside, paused, discarded).

### Cost

- Say what a change costs to run if it calls an AI or a paid API, and record that cost (`ai_usage` for AI, `platform_usage` for platform APIs).
- Automation never spends a person's credits.

### Product and interface

- **Minimal text.** Explanations go behind a "?" info pop-up, not in paragraphs on the page. Keep what people must act on visible: costs, limits, warnings, consent.
- **Plain words.** Name things the way people know them, use active voice, and make each button say what it does. Errors say what went wrong and how to fix it.
- **Accessibility.** Every control has a label linked to it (`htmlFor` when a "?" sits inside a label), works by keyboard, and has a visible focus state.
- **Every screen works** from a 320 px phone to a wide screen, in light and dark themes, with no sideways scrolling.

### Code

- Match the style of the code around it: its naming, comments and patterns.
- One focused change per pull request.
- Commit messages are short and plain: what changed and why.

## 5. Checks before every push

Run these from the repository root. All must pass. CI runs the same set and blocks merges that fail.

| Check | Command | Covers |
|---|---|---|
| Types | `pnpm typecheck` | Every package |
| Server tests | `pnpm test` | The API and business logic, inside the real Workers runtime |
| Build | `pnpm build` | The web and admin apps |
| Browser tests | `pnpm --filter @nextrium/web e2e` | Sign-up, writing, publishing, billing and waitlist flows; no sideways scroll on phones |

`pnpm check` runs the first three in one go. The browser tests start their own server on port 5174 with a separate database and fake AI. Install the test browser once with `pnpm --filter @nextrium/web exec playwright install chromium`.

**What else each kind of change needs:**

| You changed | Also do |
|---|---|
| Any API route or business rule | Tests of the happy path and of what goes wrong: bad input, another workspace, missing permission, the limit reached |
| A screen | Open it in a browser at desktop and phone width, in light and dark. Check every "?" opens and every field is labelled |
| The database schema | Generate and commit the migration; check inserts against the variable limit |
| A platform adapter or posting | Test with a fake platform response, including the platform's error responses. Never post to a real account from a test |
| Prompts or AI behaviour | Compare output on real examples before and after; note any change in cost |
| Anything that costs money to run | Record the cost and state it in the pull request |
| Anything security-related | A maintainer writes a security review before release |

CI also runs a secret scan and CodeQL on every push. The `lint` step exists but no linter is configured yet.

## 6. Definition of done

A task is done when:

- [ ] It does what its issue says, and the roadmap item is updated.
- [ ] All checks in section 5 pass, including the browser tests.
- [ ] Tests cover what can go wrong, not only the happy path.
- [ ] Any changed screen was checked in a browser.
- [ ] It works on preview after the merge.
- [ ] The changelog has a plain-words line under "Unreleased", and docs and the OpenAPI schemas are updated where they changed.
- [ ] Nothing in it needs a secret to be shared, and it adds no cost that isn't recorded.

## 7. Where things live

| What | Where |
|---|---|
| Company roadmap and progress | The shared roadmap tracker (ask a maintainer for access) |
| Tasks and bugs | GitHub issues in this repository |
| What changed | [CHANGELOG.md](../CHANGELOG.md) |
| How to run the app | [README.md](../README.md) |
| Pull-request basics | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Security reports | [SECURITY.md](../SECURITY.md) |
| Licences | [LICENSING.md](../LICENSING.md), [CLA.md](../CLA.md), [TRADEMARKS.md](../TRADEMARKS.md) |
| Internal plans, reviews and runbooks | Nextrium's private documentation, for maintainers |
