import type { Request, Response } from "express";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";

/**
 * GET /api/v1/admin/status — platform-admin access probe.
 * Guards the whole /api/v1/admin namespace; full admin sections (businesses,
 * users, subscriptions, …) land in FEATURES §40 / plan step 28.
 */
export function status(req: Request, res: Response) {
  const user = req.user;
  if (!user) {
    // requireAuth already rejects anonymous requests; defensive guard only.
    throw ApiError.unauthorized("UNAUTHENTICATED", "You need to sign in to continue.");
  }
  res.json(apiSuccess({ role: user.platformRole }));
}
