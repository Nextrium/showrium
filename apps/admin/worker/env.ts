export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** This app's address (https://admin.showrium.com). */
  ADMIN_URL: string;
  /** The product's address, for invite links (https://app.showrium.com). */
  APP_URL: string;
  /** Cloudflare Access: the team domain (e.g. "nextrium.cloudflareaccess.com") and the application's AUD tag. */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Secret: the owners (same list as the product's). */
  PLATFORM_ADMIN_EMAILS?: string;
  /** Local development only (honoured only when ADMIN_URL is http://localhost…): who you are signed in as. */
  ADMIN_DEV_EMAIL?: string;
  BREVO_API_KEY?: string;
  EMAIL_FROM?: string;
}
