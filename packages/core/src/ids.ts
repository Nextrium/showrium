import { ulid } from "ulid";

// Sortable, prefixed IDs, e.g. "org_01J9...". The prefix makes logs and support tickets readable.
export function newId(prefix: "org" | "mem" | "key" | "txn" | "ent" | "aud"): string {
  return `${prefix}_${ulid()}`;
}
