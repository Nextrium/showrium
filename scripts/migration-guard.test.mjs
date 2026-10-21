// Tests for the migration guard: node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanMigration } from "./migration-guard.mjs";

test("adding tables, columns and indexes passes", () => {
  const sql = "CREATE TABLE `a` (`id` text PRIMARY KEY NOT NULL);--> statement-breakpoint\nALTER TABLE `b` ADD `c` text;\nCREATE INDEX `i` ON `a` (`id`);";
  assert.deepEqual(scanMigration("0040_add.sql", sql), []);
});

test("every destructive statement fails", () => {
  for (const sql of [
    "DROP TABLE `draft`;",
    "drop index `i`;",
    "ALTER TABLE `draft` DROP COLUMN `text`;",
    "ALTER TABLE `draft` RENAME COLUMN `text` TO `body`;",
    "ALTER TABLE `__new_draft` RENAME TO `draft`;",
    "DELETE FROM `user`;",
    "TRUNCATE `user`;",
    "REPLACE INTO `org` VALUES (1);",
    "INSERT OR REPLACE INTO `org` VALUES (1);",
    "PRAGMA foreign_keys=OFF;",
  ]) assert.notDeepEqual(scanMigration("0041_bad.sql", sql), [], sql);
});

test("a backfill needs its marker; comments don't hide or trigger anything", () => {
  assert.equal(scanMigration("0042.sql", "UPDATE `draft` SET `x` = 1;").length, 1);
  assert.deepEqual(scanMigration("0042.sql", "-- migration-guard: allow-backfill\nUPDATE `draft` SET `x` = 1;"), []);
  assert.deepEqual(scanMigration("0043.sql", "-- we never DROP TABLE here\nCREATE TABLE `a` (`id` text);"), []);
  assert.equal(scanMigration("0044.sql", "/* fine */ DROP TABLE `a`;").length, 1);
  // The backfill marker never allows a destructive statement.
  assert.equal(scanMigration("0045.sql", "-- migration-guard: allow-backfill\nDELETE FROM `a`;").length, 1);
});

test("the one backfill merged before the guard is grandfathered, by name only", () => {
  assert.deepEqual(scanMigration("0017_even_rumiko_fujikawa.sql", "UPDATE `draft` SET `own_images` = 1;"), []);
  assert.equal(scanMigration("0017_even_rumiko_fujikawa.sql", "DROP TABLE `draft`;").length, 1);
});
