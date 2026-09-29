declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TOKEN_ENCRYPTION_KEY: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
