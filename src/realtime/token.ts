import { decode, encode } from "@auth/core/jwt";
import { env } from "../config/env";

/**
 * Socket credentials (IMPLEMENTATION_PLAN step 38).
 *
 * A browser cannot authenticate a WebSocket with the session cookie across
 * origins: the session cookie belongs to the Next.js origin, not the API's, so
 * it is simply not sent to the socket. Instead the dashboard asks the backend
 * (through a Next route handler that forwards the cookie) for a short-lived,
 * purpose-scoped token and hands that to the socket.
 *
 * The token is only ever a credential for reading the caller's own businesses'
 * conversations — rooms are derived from verified memberships, never from the
 * token's contents.
 */

/** Distinct salt → a distinct encryption key from the session cookie's. */
const REALTIME_TOKEN_SALT = "realtime-token";

/** Deliberately short: the client fetches a fresh token on every reconnect. */
export const REALTIME_TOKEN_TTL_SECONDS = 15 * 60;

/** Marks a token as a socket credential, not a session. */
const REALTIME_SCOPE = "realtime";

interface RealtimeTokenPayload {
  id?: unknown;
  sub?: unknown;
  scope?: unknown;
}

/** Mint a socket credential for one authenticated user. */
export async function createRealtimeToken(
  userId: string,
  ttlSeconds: number = REALTIME_TOKEN_TTL_SECONDS,
): Promise<string> {
  return encode({
    token: { id: userId, sub: userId, scope: REALTIME_SCOPE },
    secret: env.AUTH_SECRET,
    salt: REALTIME_TOKEN_SALT,
    maxAge: ttlSeconds,
  });
}

/**
 * Verify a socket credential. Returns the user id, or null for anything that
 * is missing, forged, expired, or not a socket token (a session cookie value
 * would not decode with this salt).
 */
export async function verifyRealtimeToken(
  token: string | undefined,
): Promise<{ userId: string } | null> {
  if (!token) return null;

  try {
    const payload = (await decode({
      token,
      secret: env.AUTH_SECRET,
      salt: REALTIME_TOKEN_SALT,
    })) as RealtimeTokenPayload | null;

    if (!payload || payload.scope !== REALTIME_SCOPE) return null;

    const userId = typeof payload.id === "string" ? payload.id : payload.sub;
    return typeof userId === "string" && userId.length > 0 ? { userId } : null;
  } catch {
    // Expired (jwtDecrypt throws), malformed, or encrypted with another key.
    return null;
  }
}
