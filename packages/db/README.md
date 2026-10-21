# packages/db

The Drizzle schema (`src/schema.ts`) and the SQL migrations for Cloudflare D1 (SQLite).

- Change the schema, then run `pnpm --filter @nextrium/db generate` and commit the generated migration.
- Migrations only add tables and columns. They run before each deploy, while the previous version is still serving.
- Every table that holds a workspace's data has an `org_id`; queries always filter by it.
