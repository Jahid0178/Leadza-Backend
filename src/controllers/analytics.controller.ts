import type { Request, Response } from "express";
import { getDashboardForBusiness } from "../repositories/analytics.repository";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";
import { dashboardQuerySchema } from "../validation/analytics.schemas";

/**
 * Analytics controller (FEATURES §28, IMPLEMENTATION_PLAN step 17).
 *
 * Read-only aggregates for the business dashboard: funnel counts,
 * conversion rate and needs-attention lists. Any member may read — leads
 * and conversations are the operational work of the business, so the
 * dashboard follows the same member-wide read rule as the lead list
 * (agent.md §6). The businessId is resolved through membership, never
 * trusted from the query string alone (§7, §52).
 */

function requireUserId(req: Request): string {
  const user = req.user;
  if (!user) {
    throw ApiError.unauthorized("UNAUTHENTICATED", "You need to sign in to continue.");
  }
  return user.id;
}

/**
 * GET /api/v1/analytics/dashboard — funnel + attention summary for one
 * business (?businessId=…). A foreign or unknown businessId answers 404 so
 * the API never leaks another tenant's existence (§13).
 */
export async function getDashboard(req: Request, res: Response) {
  const userId = requireUserId(req);

  const parsed = dashboardQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    throw ApiError.badRequest(
      "VALIDATION_ERROR",
      field ? `${field}: ${issue?.message}` : (issue?.message ?? "Invalid query."),
    );
  }

  const summary = await getDashboardForBusiness(userId, parsed.data.businessId);
  if (!summary) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(apiSuccess({ dashboard: summary }));
}
