import type { Request, Response } from "express";
import {
  computeStatsForBusiness,
  type AnalyticsRange,
} from "../repositories/analytics.repository";
import {
  getActivityAnalytics,
  getAiPerformanceAnalytics,
  getAnalyticsOverview,
  getLeadAnalytics,
  listBusinessUsageAnalytics,
} from "../repositories/admin-analytics.repository";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";
import { parseAfterAuth } from "../utils/business-access";
import {
  adminAnalyticsActivityQuerySchema,
  adminAnalyticsAiPerformanceQuerySchema,
  adminAnalyticsLeadsQuerySchema,
  adminAnalyticsOverviewQuerySchema,
  listAdminAnalyticsBusinessesQuerySchema,
} from "../validation/admin-analytics.schemas";

/**
 * Platform analytics controller (FEATURES §51, the "Admin analytics" build).
 *
 * Every handler runs behind the router-wide `requireAuth, requirePlatformAdmin`
 * gate in routes/admin.routes.ts — authorization never depends on a handler
 * even running, and the platform role is re-read from the database on every
 * request. Responses carry the reporting window + timezone so the dashboard
 * can never mislabel their bounds.
 */

/**
 * GET /api/v1/admin/analytics/overview — §51 KPI cards + previous-window
 * comparisons (where sufficient historical data exists; see resolveWindow).
 */
export async function overview(req: Request, res: Response) {
  const query = parseAfterAuth(adminAnalyticsOverviewQuerySchema, req.query);
  res.json(
    apiSuccess({
      overview: await getAnalyticsOverview(query),
    }),
  );
}

/** GET /api/v1/admin/analytics/leads — lead trends + breakdowns (§51). */
export async function leads(req: Request, res: Response) {
  const query = parseAfterAuth(adminAnalyticsLeadsQuerySchema, req.query);
  res.json(
    apiSuccess({
      leadAnalytics: await getLeadAnalytics(query),
    }),
  );
}

/** GET /api/v1/admin/analytics/ai-performance — agent outcomes + failures. */
export async function aiPerformance(req: Request, res: Response) {
  const query = parseAfterAuth(adminAnalyticsAiPerformanceQuerySchema, req.query);
  res.json(
    apiSuccess({
      aiPerformance: await getAiPerformanceAnalytics(query),
    }),
  );
}

/** GET /api/v1/admin/analytics/businesses — searchable usage table (§51). */
export async function businesses(req: Request, res: Response) {
  const query = parseAfterAuth(listAdminAnalyticsBusinessesQuerySchema, req.query);
  res.json(
    apiSuccess({
      businesses: await listBusinessUsageAnalytics(query),
    }),
  );
}

/**
 * GET /api/v1/admin/analytics/businesses/:businessId — one business's
 * analytics, computed by the same function that serves the tenant's own
 * /dashboard/analytics page (§50), so an admin sees exactly what the
 * business sees. Accepts the same ?days= presets.
 */
export async function businessAnalytics(req: Request, res: Response) {
  const businessId = req.params.businessId;
  if (typeof businessId !== "string" || businessId.length === 0) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  const days = parseAnalyticsRange(req.query.days);
  const stats = await computeStatsForBusiness(businessId, days);
  if (!stats) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  res.json(apiSuccess({ stats }));
}

/** GET /api/v1/admin/analytics/activity — recorded events + rule alerts. */
export async function activity(req: Request, res: Response) {
  const query = parseAfterAuth(adminAnalyticsActivityQuerySchema, req.query);
  res.json(
    apiSuccess({
      activity: await getActivityAnalytics(query),
    }),
  );
}

/** Reused ?days= preset validation (the drill-down only takes presets). */
function parseAnalyticsRange(value: unknown): AnalyticsRange {
  return value === "7" || value === "30" || value === "90" || value === "all" ? value : "30";
}