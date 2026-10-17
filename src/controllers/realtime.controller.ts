import type { Request, Response } from "express";
import {
  createRealtimeToken,
  REALTIME_TOKEN_TTL_SECONDS,
} from "../realtime/token";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";

/**
 * Realtime socket credentials (IMPLEMENTATION_PLAN step 38).
 *
 * Called by the Next.js app with the session cookie forwarded — the browser
 * never sees this endpoint's response headers, it only receives the token
 * through the Next route handler. The token is scoped to realtime reads and
 * expires quickly; rooms are still resolved from verified memberships.
 */

/** POST /api/v1/realtime/token — a fresh socket token for the caller. */
export async function createToken(req: Request, res: Response) {
  const userId = req.user?.id;
  if (!userId) {
    throw ApiError.unauthorized(
      "UNAUTHENTICATED",
      "You need to sign in to continue.",
    );
  }

  const token = await createRealtimeToken(userId);

  // Never cache a credential.
  res.set("cache-control", "no-store").json(
    apiSuccess({
      token,
      expiresInSeconds: REALTIME_TOKEN_TTL_SECONDS,
    }),
  );
}
