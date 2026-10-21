import { z } from "zod";

/**
 * GET /api/v1/analytics/dashboard — the tenant scope is an explicit query
 * parameter, but it is only ever honored after membership is verified in the
 * controller (agent.md §7, §52); a foreign businessId yields 404.
 */
export const dashboardQuerySchema = z.object({
  businessId: z.string().trim().min(1, "Business is required."),
});

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

/**
 * GET /api/v1/analytics/stats — same tenant-scope rule as the dashboard:
 * businessId is only honored after membership is verified in the controller
 * (agent.md §7, §52); a foreign businessId yields 404. `days` is the rolling
 * calendar window of every aggregate (FEATURES §50), "all" means all time.
 */
export const statsQuerySchema = z.object({
  businessId: z.string().trim().min(1, "Business is required."),
  days: z.enum(["7", "30", "90", "all"]).default("30"),
});

export type StatsQuery = z.infer<typeof statsQuerySchema>;
