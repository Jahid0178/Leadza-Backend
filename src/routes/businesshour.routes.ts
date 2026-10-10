import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import * as businessHourController from "../controllers/businesshour.controller";

/**
 * /api/v1/hours — membership-scoped business-hours resources (FEATURES §12,
 * agent.md §13). Flat CRUD per IMPLEMENTATION_PLAN step 11; availability
 * comes from these rows or a connected calendar — the AI never invents times
 * (§25, §34).
 *
 * Order per §34: authentication → controller (authorization and validation
 * run inside the controller so item routes can answer 403 vs 404 correctly,
 * and validation only runs after authorization per §14).
 */
const router = Router();

router.use(requireAuth);

/** GET /api/v1/hours — caller's hours; ?businessId scopes to one. */
router.get("/", businessHourController.listBusinessHours);

/** POST /api/v1/hours — add hours for a businessId the caller manages. */
router.post("/", businessHourController.createBusinessHour);

/** GET /api/v1/hours/:hourId */
router.get("/:hourId", businessHourController.getBusinessHour);

/** PATCH /api/v1/hours/:hourId */
router.patch("/:hourId", businessHourController.updateBusinessHour);

/** DELETE /api/v1/hours/:hourId */
router.delete("/:hourId", businessHourController.deleteBusinessHour);

export default router;
