import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.js";

export * from "./schema.js";
export { schema };

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof createDb>;
