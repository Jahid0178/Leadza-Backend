import { getSession } from "@auth/express";
import type { NextFunction, Request, Response } from "express";
import { findUserAuthState } from "../repositories/user.repository";
import { ApiError } from "../utils/api-error";
import { authConfig } from "./auth";
import { assertPlatformAdmin } from "./permissions";
import { toSessionUser } from "./session";

/**
 * Authentication middleware (agent.md §5):
 * Request → Auth.js → authenticated user → authorization → controller → service.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const session = await getSession(req, authConfig);
  const user = toSessionUser(session);

  if (!user) {
    throw ApiError.unauthorized("UNAUTHENTICATED", "You need to sign in to continue.");
  }

  req.user = user;
  next();
}

/**
 * Platform administrator authorization (agent.md §Platform Admin Security).
 * Never rely on the frontend to protect admin routes — this runs on every
 * admin endpoint. The decision itself lives in permissions.ts so all
 * authorization goes through one module.
 *
 * The check reads the **current database row** (IMPLEMENTATION_PLAN step 28),
 * not the session's `platformRole`: a granted or revoked role, or a suspended
 * account, takes effect on the next request instead of when the 30-day JWT
 * expires. Admin traffic is low-volume, so the extra read is cheap.
 */
export async function requirePlatformAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const user = req.user;
  if (!user) {
    // requireAuth normally runs first; defensive guard only.
    throw ApiError.unauthorized("UNAUTHENTICATED", "You need to sign in to continue.");
  }

  assertPlatformAdmin(await findUserAuthState(user.id));

  next();
}
