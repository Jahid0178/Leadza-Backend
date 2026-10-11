import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import * as leadController from "../controllers/lead.controller";

/**
 * /api/v1/leads — membership-scoped lead resources (FEATURES §15–17,
 * IMPLEMENTATION_PLAN step 14). The tenant scope is resolved server-side
 * from the authenticated user, never from a trusted client-supplied
 * businessId (§7, §52). Status changes only go through the dedicated
 * status endpoint, validated by the backend transition table (agent.md §19).
 *
 * Order per §34: authentication → validation → controller (authorization
 * lives in the controller so item routes can answer 403 vs 404 correctly).
 */
const router = Router();

router.use(requireAuth);

/** GET /api/v1/leads — filters: status, urgency, source, service, dates, score, search. */
router.get("/", leadController.listLeads);

/** POST /api/v1/leads — manual lead entry (§30). */
router.post("/", leadController.createLead);

/** GET /api/v1/leads/:leadId — detail with customer + service (§30). */
router.get("/:leadId", leadController.getLead);

/** PATCH /api/v1/leads/:leadId — qualification fields; never status. */
router.patch("/:leadId", leadController.updateLead);

/** PATCH /api/v1/leads/:leadId/status — backend-validated transition (§19). */
router.patch("/:leadId/status", leadController.changeLeadStatus);

export default router;
