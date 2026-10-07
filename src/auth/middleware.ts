import { getSession } from "@auth/express";
import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../utils/api-error";
import { authConfig } from "./auth";
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
 * Never rely on the frontend to protect admin routes — this runs on every admin endpoint.
 */
export function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.platformRole !== "PLATFORM_ADMIN") {
    throw ApiError.forbidden(
      "PLATFORM_ADMIN_REQUIRED",
      "Platform administrator access is required.",
    );
  }
  next();
}
