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
