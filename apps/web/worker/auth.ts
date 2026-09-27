import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createDb, schema } from "@nextrium/db";
import { createPersonalOrg } from "@nextrium/core";
import { authProviders, type Env } from "./env.js";

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
    emailAndPassword: { enabled: providers.password, minPasswordLength: 10 },
    socialProviders,
    databaseHooks: {
      user: {
        create: {
          // Every new user gets a personal workspace, owner role and the beta welcome credits.
          after: async (user) => {
            await createPersonalOrg(db, { userId: user.id, userName: user.name });
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
