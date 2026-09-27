export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Origin of the product (sign-in, dashboard, API): https://app.showrium.com in production. */
  BETTER_AUTH_URL: string;
  /** Origin of the public website: https://showrium.com in production. */
  SITE_URL: string;
  BETTER_AUTH_SECRET: string;
  AUTH_PASSWORD_ENABLED: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

export function authProviders(env: Env) {
  return {
    password: env.AUTH_PASSWORD_ENABLED === "true",
    github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  };
}
