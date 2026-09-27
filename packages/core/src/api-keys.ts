// API keys for developers and businesses. Only a SHA-256 hash is stored; the key itself
// is shown once, at creation. Keys look like "shr_live_<43 random chars>".
import { and, desc, eq, isNull } from "drizzle-orm";
import { apiKey, type Db } from "@nextrium/db";
import { newId } from "./ids.js";

const KEY_PREFIX = "shr_live_";
const LAST_USED_WRITE_INTERVAL_MS = 60 * 60 * 1000; // Save D1 writes: update at most hourly.

export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createApiKey(db: Db, input: { orgId: string; name: string; createdByUserId: string | null }) {
  const key = `${KEY_PREFIX}${randomSecret()}`;
  const row = {
    id: newId("key"),
    orgId: input.orgId,
    name: input.name,
    prefix: key.slice(0, KEY_PREFIX.length + 4),
    hash: await hashApiKey(key),
    createdByUserId: input.createdByUserId,
  };
  await db.insert(apiKey).values(row);
  return { id: row.id, name: row.name, prefix: row.prefix, key };
}

export async function listApiKeys(db: Db, orgId: string) {
  return db
    .select({
      id: apiKey.id,
      name: apiKey.name,
      prefix: apiKey.prefix,
      lastUsedAt: apiKey.lastUsedAt,
      revokedAt: apiKey.revokedAt,
      createdAt: apiKey.createdAt,
    })
    .from(apiKey)
    .where(eq(apiKey.orgId, orgId))
    .orderBy(desc(apiKey.createdAt));
}

/** Returns true when a key was revoked; false when it doesn't exist in this org or was already revoked. */
export async function revokeApiKey(db: Db, orgId: string, id: string): Promise<boolean> {
  const updated = await db
    .update(apiKey)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKey.id, id), eq(apiKey.orgId, orgId), isNull(apiKey.revokedAt)))
    .returning({ id: apiKey.id });
  return updated.length > 0;
}

export async function resolveApiKey(db: Db, key: string): Promise<{ id: string; orgId: string } | null> {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const [row] = await db
    .select({ id: apiKey.id, orgId: apiKey.orgId, lastUsedAt: apiKey.lastUsedAt })
    .from(apiKey)
    .where(and(eq(apiKey.hash, await hashApiKey(key)), isNull(apiKey.revokedAt)));
  if (!row) return null;
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
    await db.update(apiKey).set({ lastUsedAt: new Date() }).where(eq(apiKey.id, row.id));
  }
  return { id: row.id, orgId: row.orgId };
}
