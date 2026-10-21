import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import * as analyticsController from "../controllers/analytics.controller";

/**
 * /api/v1/analytics — membership-scoped read-only aggregates
 * (FEATURES §28 / step 17 dashboard, FEATURES §50 / step 33 business
 * analytics). The tenant scope is resolved server-side from the
 * authenticated user, never from a trusted client-supplied businessId
 * (§7, §52).
 *
 * Order per §34: authentication → validation → controller (authorization
 * lives in the controller so a foreign businessId can answer 404).
 */
const router = Router();

router.use(requireAuth);

/** GET /api/v1/analytics/dashboard — funnel counts + needs-attention. */
router.get("/dashboard", analyticsController.getDashboard);

/** GET /api/v1/analytics/stats — §50 page aggregates (funnel, response
 *  time, sources, daily volume) for one optional ?days window. */
router.get("/stats", analyticsController.getStats);

export default router;
