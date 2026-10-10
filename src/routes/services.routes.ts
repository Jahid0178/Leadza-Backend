import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import * as serviceController from "../controllers/service.controller";

/**
 * /api/v1/services — membership-scoped service resources (FEATURES §10,
 * agent.md §13). Flat CRUD per IMPLEMENTATION_PLAN step 09; the tenant scope
 * is resolved server-side from the authenticated user, never from a trusted
 * client-supplied businessId (§7, §52).
 *
 * Order per §34: authentication → validation → controller (authorization
 * lives in the controller so item routes can answer 403 vs 404 correctly).
 */
const router = Router();

router.use(requireAuth);

/** GET /api/v1/services — caller's services; ?businessId scopes to one. */
router.get("/", serviceController.listServices);

/** POST /api/v1/services — create under a businessId the caller manages. */
router.post("/", serviceController.createService);

/** GET /api/v1/services/:serviceId */
router.get("/:serviceId", serviceController.getService);

/** PATCH /api/v1/services/:serviceId */
router.patch("/:serviceId", serviceController.updateService);

/** DELETE /api/v1/services/:serviceId — soft delete (active=false). */
router.delete("/:serviceId", serviceController.archiveService);

export default router;
