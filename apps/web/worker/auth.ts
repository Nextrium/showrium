import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createDb, schema } from "@nextrium/db";
import { canSignUp, claimInvite, createPersonalOrg, readCookie, recordInviteAcceptedBy, teamInviteAllowsSignUp } from "@nextrium/core";
import { actionEmail, emailConfigured, sendEmail } from "./email.js";
import { authProviders, signupMode, type Env } from "./env.js";

export const INVITE_COOKIE = "showrium_invite";

type HookContext = { headers?: Headers; request?: Request } | null | undefined;
function inviteTokenFrom(context: HookContext): string | null {
  const cookie = context?.headers?.get("cookie") ?? context?.request?.headers.get("cookie");
  return readCookie(cookie, INVITE_COOKIE);
}

// Created per request: D1 and secrets are only available on the request's env.
export function createAuth(env: Env) {
  const db = createDb(env.DB);
  const providers = authProviders(env);
  const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
  if (providers.github) socialProviders.github = { clientId: env.GITHUB_CLIENT_ID!, clientSecret: env.GITHUB_CLIENT_SECRET! };
  if (providers.google) socialProviders.google = { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! };

  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.BETTER_AUTH_URL],
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: { user: schema.user, session: schema.session, account: schema.account, verification: schema.verification },
    }),
    emailAndPassword: {
      enabled: providers.password,
      minPasswordLength: 10,
      // Links last an hour; a reset signs the account out everywhere else.
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      ...(emailConfigured(env)
        ? {
            sendResetPassword: async ({ user, url }: { user: { email: string; name: string }; url: string }) => {
              await sendEmail(
                env,
                actionEmail({
                  to: user.email,
                  name: user.name,
                  subject: "Reset your Showrium password",
                  intro: "Someone asked to reset the password for your Showrium account. If it was you, choose a new password below. The link works for one hour.",
                  button: "Choose a new password",
                  url,
                  outro: "If you didn't ask for this, ignore this email. Your password stays the same.",
                }),
              );
            },
          }
        : {}),
    },
    // Email verification: sent on sign-up when email is configured. Not required to sign in yet
    // (beta), but only verified emails can be linked to Google or GitHub sign-in later.
    ...(emailConfigured(env)
      ? {
          emailVerification: {
            sendOnSignUp: true,
            autoSignInAfterVerification: true,
            expiresIn: 24 * 60 * 60,
            sendVerificationEmail: async ({ user, url }: { user: { email: string; name: string }; url: string }) => {
              await sendEmail(
                env,
                actionEmail({
                  to: user.email,
                  name: user.name,
                  subject: "Confirm your email for Showrium",
                  intro: "Welcome to Showrium. Confirm this is your email address, so you can recover your account and connect Google or GitHub sign-in later.",
                  button: "Confirm my email",
                  url,
                  outro: "If you didn't create a Showrium account, ignore this email.",
                }),
              );
            },
          },
        }
      : {}),
    socialProviders,
    account: {
      // OAuth access/refresh tokens are encrypted at rest (the privacy policy promises this).
      encryptOAuthTokens: true,
      // Only link a new sign-in method to an existing account when the email is verified on both sides.
      accountLinking: { enabled: true, requireLocalEmailVerified: true },
    },
    telemetry: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          // Who may create an account: allowlisted emails (allowlist mode only), or anyone
          // holding a valid invite link (any mode). Invites are consumed atomically here.
          // Existing users are unaffected (this runs only when an account is created).
          before: async (user, context) => {
            if (canSignUp(signupMode(env), user.email, env.BETA_ALLOWED_EMAILS)) return;
            const token = inviteTokenFrom(context as HookContext);
            if (token && (await teamInviteAllowsSignUp(db, token, user.email))) return;
            if (token && (await claimInvite(db, token))) return;
            console.warn(`sign-up blocked (mode: ${signupMode(env)}, invite: ${token ? "invalid or used" : "none"})`);
            return false;
          },
          // Every new user gets a personal workspace, owner role and the beta welcome credits.
          after: async (user, context) => {
            const token = inviteTokenFrom(context as HookContext);
            if (token) await recordInviteAcceptedBy(db, token, user.id).catch((e) => console.error("invite bookkeeping failed", e));
            // If this fails, the account still exists; requirePrincipal() self-heals on first use.
            try {
              await createPersonalOrg(db, { userId: user.id, userName: user.name });
            } catch (error) {
              console.error("personal workspace creation failed at sign-up; will retry on first request", error);
            }
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
