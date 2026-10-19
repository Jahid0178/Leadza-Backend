import type { Request, Response } from "express";
import { readUsage } from "../services/usage.service";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";

/**
 * Tenant usage dashboard (FEATURES §48, IMPLEMENTATION_PLAN step 31).
 *
 * The business id comes from the membership `resolveMembership()` verified on
 * the route — never from the query string or body (§13). A non-member is
 * already answered 404 before this handler runs.
 */
export async function getUsage(req: Request, res: Response) {
  const membership = req.membership;
  if (!membership) {
    // Programming error: the route is missing resolveMembership upstream.
    throw ApiError.internal(
      "AUTHZ_NOT_RESOLVED",
      "Something went wrong. Please try again.",
    );
  }

  const usage = await readUsage(membership.businessId);
  res.json(apiSuccess(usage));
}
