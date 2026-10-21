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

**Where it stands:** a private beta at [app.showrium.com](https://app.showrium.com). Work happens on `develop`, which runs at preview.showrium.com. The company roadmap tracks every phase to public launch, and its tasks live in the [Nextrium contributors portal](https://contribute.nextrium.org/).

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

1. **Task.** Pick up a task in the [contributors portal](https://contribute.nextrium.org/). Every task belongs to an item on the company roadmap. Big changes agree the approach with a code owner before work starts.
2. **Branch.** Create a branch from `develop` (for example `feature/link-comment` or `fix/x-reads`). Nobody commits to `develop` or `main` directly: the branch rules refuse it.
3. **Build and check.** Write the change with its tests, then run the checks in section 5 until they all pass.
4. **Pull request into `develop`.** Fill in the template and link the task. A code owner must approve, and every required check must pass, before it can merge.
5. **Preview.** Merging into `develop` deploys to preview.showrium.com: migrations first, then the app, then a health check. Check the change there.
6. **Release.** A release is a pull request from `develop` into `main` (merged as a merge commit), which deploys to production after an approver confirms. Releases need the roadmap gate for that phase to be met.
7. **Close the loop.** Mark the task done in the portal, and add a line to `CHANGELOG.md` under "Unreleased" in plain words.

**Tasks and findings are different.** Planned work is a task in the contributors portal. Something found that isn't on the roadmap (a bug, a gap, a risk) is a **finding**: open a GitHub issue with the Finding template. A finding may become a task.

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

- **Migrations only add.** Edit `packages/db/src/schema.ts`, run `pnpm --filter @nextrium/db generate`, and commit the generated migration. CI enforces this (section 6): a migration that drops, deletes, renames or rebuilds anything, or an edit to a merged migration, can't merge.
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

`pnpm check` runs the first three in one go. If you changed a migration, also run `node scripts/migration-guard.mjs origin/develop`. The browser tests start their own server on port 5174 with a separate database and fake AI. Install the test browser once with `pnpm --filter @nextrium/web exec playwright install chromium`.

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
| A migration | The migration guard must pass. A backfill (`UPDATE`) needs the marker line `-- migration-guard: allow-backfill` and code-owner review |

CI also runs the migration guard, a secret scan and CodeQL on every push. The `lint` step exists but no linter is configured yet.

## 6. How data is protected

Preview and production both hold real accounts and real posts, and Showrium can't afford to lose data. These protections are enforced by GitHub and Cloudflare themselves, not by instructions, so they hold for people and AI agents alike.

| Protection | What it enforces |
|---|---|
| Branch rules on `develop` and `main` | Changes arrive only through pull requests. No direct pushes, force-pushes or branch deletion. Each merge needs a code owner's approval and every required check passing. |
| Code owners | Changes to migrations, the migration guard, CI and deploy files, and Cloudflare configuration need a code owner's approval. |
| Migration guard (required check) | Fails on any destructive statement (`DROP`, `DELETE`, `TRUNCATE`, `RENAME`, `ALTER … DROP`, replace-inserts, table rebuilds) and on any edit to a merged migration. A data backfill (`UPDATE`) needs an explicit marker line and code-owner review. Deploys wait for it. |
| Deploy keys in GitHub environments | Only the deploy pipeline holds a Cloudflare key. The `preview` environment releases it only to `develop`, and `production` only to `main`, after an approver confirms. No other branch, workflow or person gets it. |
| No database access for contributors | Contributors and their tools never get Cloudflare accounts, keys or access to the preview or production databases. |
| Backups | Cloudflare D1 can restore a database to any minute of the past 30 days (Workers Paid). A scheduled export keeps a copy apart from the database. |

**Who gets which access:**

| Who | Access | How |
|---|---|---|
| Community contributors | None needed | Fork the repository and open a pull request from the fork. Sign the CLA once. |
| Regular contributors | Write, through the `showrium-contributors` team | Push branches to the repository and open pull requests into `develop`. |
| Code owners | Maintain, through the `showrium-code-owners` team | Approve merges into `develop` and `main`. |

Write access can't push to `develop` or `main`, merge without a code owner's approval, or change settings, branch rules or deploy keys. Ask a code owner to be added to a team.

**Contributors need no Cloudflare account.** Local development runs on a local copy of the database with fake AI, which is also how every test runs. Code reaches preview only by being merged.

**Testing real posting** from a laptop needs a contributor's own developer app and test account on that platform, never Nextrium's keys or accounts. Most work doesn't need it: tests use fake platform responses.

**AI coding agents** follow the same rules as people, and the rules above don't depend on them reading this. An agent works only on a contributor's machine and branch, with no Cloudflare key, so it has nothing to damage on preview or production.

**Emergencies.** Only the organisation admin can bypass the branch rules, and only through a pull request. GitHub records every bypass.

## 7. Definition of done

A task is done when:

- [ ] It does what its task says, and the task is updated in the contributors portal.
- [ ] All checks in section 5 pass, including the browser tests.
- [ ] Tests cover what can go wrong, not only the happy path.
- [ ] Any changed screen was checked in a browser.
- [ ] It works on preview after the merge.
- [ ] The changelog has a plain-words line under "Unreleased", and docs and the OpenAPI schemas are updated where they changed.
- [ ] Nothing in it needs a secret to be shared, and it adds no cost that isn't recorded.

## 8. Where things live

| What | Where |
|---|---|
| Tasks and progress | The [Nextrium contributors portal](https://contribute.nextrium.org/) |
| Findings (bugs, gaps, risks not on the roadmap) | GitHub issues in this repository, with the Finding template |
| What changed | [CHANGELOG.md](../CHANGELOG.md) |
| How to run the app | [README.md](../README.md) |
| Pull-request basics | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Security reports | [SECURITY.md](../SECURITY.md) |
| Licences | [LICENSING.md](../LICENSING.md), [CLA.md](../CLA.md), [TRADEMARKS.md](../TRADEMARKS.md) |
| Internal plans, reviews and runbooks | Nextrium's private documentation, for maintainers |
