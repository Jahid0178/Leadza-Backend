import { getSession } from "@auth/express";
import type { NextFunction, Request, Response } from "express";
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
 */
export function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction) {
  assertPlatformAdmin(req.user);
  next();
}
