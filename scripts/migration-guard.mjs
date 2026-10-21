// Migration guard: data must never be lost, so migrations may only add (CI runs this; a failure blocks
// the merge and the deploy). Two checks:
//   1. Every migration already merged is frozen: none may be edited, removed or renamed, and the
//      journal may only grow (compared with the base commit, when there is one).
//   2. No migration may contain a destructive statement. A data backfill (UPDATE) is allowed only in a
//      file that says so on a line of its own: "-- migration-guard: allow-backfill" (code owners review it).
//
// Usage: node scripts/migration-guard.mjs [base-commit]
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "packages/db/migrations";
const JOURNAL = `${DIR}/meta/_journal.json`;
const BACKFILL_MARK = /^\s*--\s*migration-guard:\s*allow-backfill\s*$/m;

/** Statements that delete or overwrite data, or rebuild a table (how SQLite "alters" a column). */
const FORBIDDEN = [
  { re: /\bDROP\s+(TABLE|INDEX|VIEW|TRIGGER|COLUMN)\b/i, why: "DROP removes a table, index or column" },
  { re: /\bALTER\s+TABLE\s+\S+\s+(DROP|RENAME)\b/i, why: "ALTER TABLE … DROP/RENAME removes or renames what the running app uses" },
  { re: /\bRENAME\s+TO\b/i, why: "RENAME TO renames a table the running app uses" },
  { re: /\bDELETE\s+FROM\b/i, why: "DELETE removes rows" },
  { re: /\bTRUNCATE\b/i, why: "TRUNCATE removes rows" },
  { re: /\bREPLACE\s+INTO\b|\bINSERT\s+OR\s+REPLACE\b/i, why: "REPLACE overwrites rows" },
  { re: /\bPRAGMA\s+foreign_keys\s*=\s*(OFF|0)\b/i, why: "switching off foreign keys is how a table is rebuilt (copy, drop, rename)" },
];
const BACKFILL = { re: /\bUPDATE\s+\S+\s+SET\b/i, why: "UPDATE overwrites existing data" };

/** Migrations merged before this guard existed, with what they were allowed to do. */
const GRANDFATHERED = { "0017_even_rumiko_fujikawa.sql": ["UPDATE"] };

const stripComments = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

/** Problems in one migration's SQL (empty when it's safe). Exported for the guard's own tests. */
export function scanMigration(name, sql) {
  const body = stripComments(sql);
  const problems = FORBIDDEN.filter((f) => f.re.test(body)).map((f) => `${name}: ${f.why}.`);
  if (BACKFILL.re.test(body) && !BACKFILL_MARK.test(sql) && !(GRANDFATHERED[name] ?? []).includes("UPDATE")) {
    problems.push(`${name}: ${BACKFILL.why}. A deliberate backfill needs the line "-- migration-guard: allow-backfill" and code-owner review.`);
  }
  return problems;
}

/** Problems with changes to migrations that were already merged at `base`. */
export function checkFrozen(base) {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
  const problems = [];
  const changed = git("diff", "--name-status", "--no-renames", base, "--", DIR).trim().split("\n").filter(Boolean);
  for (const line of changed) {
    const [status, file] = line.split("\t");
    if (file === JOURNAL || status === "A") continue;
    problems.push(`${file}: a merged migration was ${status === "D" ? "deleted" : "changed"}. Merged migrations are frozen; add a new one instead.`);
  }
  let before;
  try {
    before = JSON.parse(git("show", `${base}:${JOURNAL}`)).entries ?? [];
  } catch {
    before = []; // no journal at the base yet
  }
  const after = JSON.parse(readFileSync(JOURNAL, "utf8")).entries ?? [];
  const same = before.every((e, i) => JSON.stringify(e) === JSON.stringify(after[i]));
  if (!same || after.length < before.length) problems.push(`${JOURNAL}: earlier entries changed. The journal may only grow.`);
  return problems;
}

function main() {
  const base = process.argv[2];
  const problems = [];
  for (const name of readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()) {
    problems.push(...scanMigration(name, readFileSync(join(DIR, name), "utf8")));
  }
  if (base && !/^0+$/.test(base)) problems.push(...checkFrozen(base));
  if (problems.length) {
    console.error(`Migration guard failed. Showrium can't lose data, so migrations may only add.\n\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`Migration guard passed${base && !/^0+$/.test(base) ? ` (compared with ${base.slice(0, 7)})` : ""}.`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) main();
