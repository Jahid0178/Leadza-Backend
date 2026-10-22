import { Router } from "express";
import { requireAuth, requirePlatformAdmin } from "../auth/middleware";
import * as adminController from "../controllers/admin.controller";
import * as adminAnalyticsController from "../controllers/admin-analytics.controller";

/**
 * /api/v1/admin — every endpoint requires an authenticated PLATFORM_ADMIN
 * (agent.md §Platform Admin Security). The gate runs router-wide so even
 * unmatched admin paths answer 403 to non-admins instead of revealing
 * which routes exist.
 *
 * IMPLEMENTATION_PLAN steps 28–29: §41 overview, §42 businesses
 * (list/detail/suspend/restore), §43 users (list/detail/suspend/restore/
 * platform role) and §45 audit logs. The audit trail is **read-only**: there is
 * deliberately no POST/PATCH/DELETE route for it, so those requests fall
 * through to the API's 404.
 *
 * §51 platform analytics (steps 33b) live at /admin/analytics/* — see the
 * nested router at the bottom.
 */
const router = Router();

router.use(requireAuth, requirePlatformAdmin);

router.get("/status", adminController.status);

router.get("/overview", adminController.overview);

router.get("/businesses", adminController.listBusinesses);
router.get("/businesses/:businessId", adminController.getBusiness);
router.patch("/businesses/:businessId/status", adminController.changeBusinessStatus);

router.get("/users", adminController.listUsers);
router.get("/users/:userId", adminController.getUser);
router.patch("/users/:userId/status", adminController.changeUserStatus);
router.patch("/users/:userId/platform-role", adminController.changePlatformRole);

router.get("/audit-logs", adminController.listAuditLogs);

/** Phase H billing — read-only mirror of Paddle subscriptions (all tenants). */
router.get("/subscriptions", adminController.listSubscriptions);

/** Phase H AI usage — §49 cost + volume per business, this month (step 32). */
router.get("/usage", adminController.listUsage);

/**
 * §51 platform analytics (the "Admin analytics" build) — a nested path space
 * below /admin/analytics. The window rule (from inclusive, to inclusive as a
 * calendar day), metric definitions and the reporting timezone ( UTC) live
 * in repositories/admin-analytics.repository.ts, one authoritative place.
 */
const analytics = Router();
analytics.get("/overview", adminAnalyticsController.overview);
analytics.get("/leads", adminAnalyticsController.leads);
analytics.get("/ai-performance", adminAnalyticsController.aiPerformance);
analytics.get("/businesses", adminAnalyticsController.businesses);
analytics.get("/businesses/:businessId", adminAnalyticsController.businessAnalytics);
analytics.get("/activity", adminAnalyticsController.activity);
router.use("/analytics", analytics);

export default router;
