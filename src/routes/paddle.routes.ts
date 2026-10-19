import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import * as paddleController from "../controllers/paddle.controller";

/**
 * /api/v1/paddle — authenticated billing endpoints (Phase H).
 *
 * The webhook is deliberately NOT here: it needs the raw request body and is
 * mounted directly on the app before `express.json()` (see `app.ts`).
 */
const router = Router();

router.use(requireAuth);

/** POST /api/v1/paddle/portal — hosted customer-portal URL for a business. */
router.post("/portal", paddleController.createPortalSession);

/** POST /api/v1/paddle/reconcile — pull current Paddle state into our mirror. */
router.post("/reconcile", paddleController.reconcileBilling);

/** GET /api/v1/paddle/status?businessId=… — mirrored billing state. */
router.get("/status", paddleController.getBillingStatus);

export default router;
