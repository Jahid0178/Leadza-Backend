import Credentials from "@auth/core/providers/credentials";
import type { ExpressAuthConfig } from "@auth/express";
import { z } from "zod";
import { env } from "../config/env";
import { verifyCredentials } from "../services/auth.service";
import { SESSION_MAX_AGE_SECONDS, sessionCookieName, useSecureCookies } from "./session";
import type { PlatformRole } from "./types";

const authorizeSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * Auth.js configuration — authentication lives on the backend (agent.md §5).
 * Mounted in app.ts at /api/auth; also used by getSession() for protected routes.
 */
export const authConfig: ExpressAuthConfig = {
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials) => {
        const parsed = authorizeSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const user = await verifyCredentials(parsed.data.email, parsed.data.password);
        if (!user) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          platformRole: user.platformRole,
        };
      },
    }),
  ],
  secret: env.AUTH_SECRET,
  session: {
    strategy: "jwt",
    maxAge: SESSION_MAX_AGE_SECONDS,
  },
  useSecureCookies,
  cookies: {
    // Keep the cookie name in one place so our custom login/logout and Auth.js agree.
    sessionToken: { name: sessionCookieName },
  },
  pages: {
    signIn: "/login",
  },
  callbacks: {
    jwt: ({ token, user }) => {
      if (user) {
        token.id = user.id;
        token.platformRole = (user as { platformRole?: PlatformRole }).platformRole ?? "USER";
      }
      return token;
    },
    session: ({ session, token }) => {
      if (session.user) {
        session.user.id = (token.id as string | undefined) ?? token.sub ?? "";
        session.user.platformRole =
          (token.platformRole as PlatformRole | undefined) ?? "USER";
      }
      return session;
    },
  },
};
