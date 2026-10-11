import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import * as serviceAreaController from "../controllers/servicearea.controller";

/**
 * /api/v1/areas — membership-scoped service-area resources (FEATURES §11,
 * agent.md §13). Flat CRUD per IMPLEMENTATION_PLAN step 10; the tenant scope
 * is resolved server-side from the authenticated user (§7, §52).
 *
 * Order per §34: authentication → validation → controller (authorization
 * lives in the controller so item routes can answer 403 vs 404 correctly).
 */
const router = Router();

router.use(requireAuth);

/** GET /api/v1/areas — caller's areas; ?businessId scopes to one. */
router.get("/", serviceAreaController.listServiceAreas);

/** POST /api/v1/areas — add an area to a businessId the caller manages. */
router.post("/", serviceAreaController.createServiceArea);

/** GET /api/v1/areas/:areaId */
router.get("/:areaId", serviceAreaController.getServiceArea);

/** PATCH /api/v1/areas/:areaId */
router.patch("/:areaId", serviceAreaController.updateServiceArea);

/** DELETE /api/v1/areas/:areaId */
router.delete("/:areaId", serviceAreaController.deleteServiceArea);

export default router;
