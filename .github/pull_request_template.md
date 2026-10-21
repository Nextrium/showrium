## What and why

Task: <!-- link to the task in https://contribute.nextrium.org/ -->
Fixes: <!-- #finding, if any -->

## How it was tested

<!-- The tests added, what can go wrong that they cover, and the browser check for any changed screen (desktop and phone, light and dark). -->

## Checklist (see docs/HANDBOOK.md)

- [ ] `pnpm check` passes (types, server tests, build)
- [ ] `pnpm --filter @nextrium/web e2e` passes
- [ ] Tests cover what can go wrong, not only the happy path
- [ ] Any changed screen checked in a browser at desktop and phone width, light and dark
- [ ] Database changes only add, with the generated migration included (the migration guard passes)
- [ ] Docs, the OpenAPI schemas and the changelog ("Unreleased") updated where they changed
- [ ] Any new AI or paid API cost is recorded and stated above
- [ ] No secrets, tokens or personal data committed
- [ ] I've signed the [Contributor License Agreement](../CLA.md) (the bot asks on your first pull request)
