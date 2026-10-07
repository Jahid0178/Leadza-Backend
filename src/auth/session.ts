import { encode } from "@auth/core/jwt";
import type { Session } from "@auth/core/types";
import type { CookieOptions } from "express";
import { env } from "../config/env";
import type { SessionUser } from "./types";

/** Secure cookies only over HTTPS; derived once so Auth.js and our routes always agree. */
export const useSecureCookies = env.NODE_ENV === "production";

/** Must match Auth.js's own session cookie name (salt used when encoding the JWT). */
export const sessionCookieName = useSecureCookies
  ? "__Secure-authjs.session-token"
  : "authjs.session-token";

/** Auth.js default session max-age: 30 days (in seconds). */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: useSecureCookies,
    expires: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000),
  };
}

/**
 * Issues an Auth.js-compatible session JWT for a user.
 * The salt must be the cookie name, exactly like Auth.js does internally,
 * so getSession() can decode it.
 */
export async function createSessionToken(user: SessionUser): Promise<string> {
  return encode({
    token: {
      id: user.id,
      sub: user.id,
      name: user.name,
      email: user.email,
      picture: null,
      platformRole: user.platformRole,
    },
    secret: env.AUTH_SECRET,
    salt: sessionCookieName,
  });
}

/** Maps an Auth.js session to the safe shape exposed by our API (never leak raw internals). */
export function toSessionUser(session: Session | null): SessionUser | null {
  const user = session?.user;
  if (!user?.id || !user.email) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name ?? null,
    platformRole: user.platformRole === "PLATFORM_ADMIN" ? "PLATFORM_ADMIN" : "USER",
  };
}
