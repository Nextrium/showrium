# Contributing to Showrium

Thanks for helping! Bug reports, fixes, docs and features are all welcome.

Read the [contributor handbook](docs/HANDBOOK.md) first: what Showrium is, how work flows from the roadmap to a release, the standards, and the checks every change passes.

## Before you start

- **The licence and the CLA.** Showrium is licensed under AGPL-3.0, and Nextrium also sells it under a commercial licence ([LICENSING.md](LICENSING.md)). Every contributor signs the [Contributor License Agreement](CLA.md) once: a bot asks on your first pull request, and you reply with one sentence. You keep the copyright in your work.
- **Security problems:** don't open a public issue. See [SECURITY.md](SECURITY.md).
- **Tasks** live in the [Nextrium contributors portal](https://contribute.nextrium.org/). Pick one up there.
- **Findings** (a bug, gap or risk that isn't on the roadmap): open a GitHub issue with the **Finding** template.
- **Big changes:** agree the approach with a code owner before starting.

## Set up

Follow "Run it locally" in the [README](README.md). You'll need Node 22 and pnpm 10.

## Making a change

1. **Branch:** create a branch from **`develop`** (or fork the repo first). Direct pushes to `develop` and `main` are refused; every change arrives through a pull request, approved by a code owner.
2. **Keep the change focused.** One fix or feature per pull request.
3. **Follow the rules below.**
4. **Run the checks:**

   ```bash
   pnpm check                        # types, server tests and build
   pnpm --filter @nextrium/web e2e   # browser tests (install the browser once: pnpm --filter @nextrium/web exec playwright install chromium)
   ```

   Section 5 of the [handbook](docs/HANDBOOK.md) lists what else each kind of change needs.

5. **Open a pull request into `develop`.** Fill in the template, and say what you tested, including a browser check for any screen you changed.

## Rules

- **Workspaces stay apart.** Every query is filtered by the workspace (`org_id`) taken from the signed-in session or API key, never from the request body. Add a test showing another workspace can't read or change your new data. The tenant-isolation test checks every route with an id automatically.
- **Check the permission in every action.** Being signed in isn't enough: use `can(role, …)` for each write.
- **Fail closed.** Errors, unknown roles and missing settings deny access.
- **Validate input** with Zod at the API boundary. Document new endpoints in the OpenAPI schemas.
- **Database changes only add.** Edit `packages/db/src/schema.ts`, run `pnpm --filter @nextrium/db generate`, and commit the generated migration. Never drop or rename a column in use. Migrations run before the new version is deployed. Keep multi-row inserts under D1's 100-variable limit (`chunkRows`).
- **Platform rules come first.** Official APIs only, never scraping. Automation never replies, mentions, likes or messages.
- **No secrets** in code, tests, logs or commits. Local secrets live in `apps/web/.dev.vars`, which is git-ignored.
- **AI text is untrusted.** Material from feeds, links and web search is information, never instructions. Keep it inside its prompt tags.
- **Cost matters.** Showrium is priced for $1–$10 plans. Say what a change costs to run if it calls an AI or a paid API.
- **Accessibility:** labels on every control, keyboard access, and screens that fit a 320 px phone in light and dark themes.

## Commit messages

Short and clear: say what changed and why, in plain words.

## Code of conduct

Be kind and constructive. Harassment or abuse of any kind isn't tolerated. Report problems to legal@showrium.com.
