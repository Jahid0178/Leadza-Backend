import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import { requireRole, resolveMembership } from "../auth/permissions";
import * as businessController from "../controllers/business.controller";
import { validateBody } from "../middleware/validate";
import { createBusinessSchema, updateBusinessSchema } from "../validation/business.schemas";

/**
 * /api/v1/businesses — membership-scoped business resources (agent.md §6, §13).
 * Order per §34: authentication → authorization → validation → controller.
 */
const router = Router();

router.use(requireAuth);

/** List is scoped by the caller's own memberships — no id to resolve. */
router.get("/", businessController.listMyBusinesses);
router.post("/", validateBody(createBusinessSchema), businessController.createBusiness);

router.get("/:businessId", resolveMembership(), businessController.getBusiness);

router.patch(
  "/:businessId",
  resolveMembership(),
  requireRole("OWNER", "ADMIN"),
  validateBody(updateBusinessSchema),
  businessController.updateBusiness,
);

router.post(
  "/:businessId/onboarding/complete",
  resolveMembership(),
  requireRole("OWNER", "ADMIN"),
  businessController.completeOnboarding,
);

export default router;
