# Showrium: guidance for Claude

**Follow the Nextrium operational protocol** in the private docs repo at `../internal-docs/engineering/operational-protocol.md`. If it isn't available, ask the owner for it before changing code. The key rules:

- **Branches:** work on `develop` only; `main` is protected. Run `git branch --show-current` and `git pull origin develop` before any work.
- **Commits:** never run `git commit` or `git push` yourself; hand the owner the PowerShell commands. Commit messages are short, written to a file outside the repo, and passed with `git commit -F <file>`. No AI or Co-Authored-By lines.
- **Definition of done:** typecheck, production build and tests pass; a no-mercy security and edge-case review is written up (in internal-docs, never in this public repo); UI changes have had a real browser check. Say honestly what wasn't verified.
- **Secrets:** never in chat or the repo. Read `.env.local` only to test or to upload to Cloudflare, and never print values.
- **Database:** migrations are additive, generated with Drizzle (`packages/db`), and applied by CI before deploy. Never run destructive statements against the live database.
- **Cost first** (ADR-0003), and no single AI provider (ADR-0004).
- **Hand-off format:** what changed and what was verified; the security note ("checked against the seven"); the PowerShell block; the PR title and description (use a merge commit for `develop` into `main`).

Project layout: `apps/web` is one Worker (the React app plus the Hono API), `packages/db` holds the schema and migrations, and `packages/core` the business logic. Internal plans are in `../internal-docs/projects/showrium/`.
