import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import * as knowledgeController from "../controllers/knowledge.controller";

/**
 * /api/v1/knowledge — membership-scoped knowledge resources (FEATURES §13,
 * agent.md §13). Flat CRUD per IMPLEMENTATION_PLAN step 12; knowledge scope
 * is the current business only, so the AI context builder can load entries
 * without leaking across tenants.
 *
 * Order per §34: authentication → controller (authorization and validation
 * run inside the controller so item routes can answer 403 vs 404 correctly,
 * and validation only runs after authorization per §14).
 */
const router = Router();

router.use(requireAuth);

/** GET /api/v1/knowledge — caller's entries; ?businessId scopes to one. */
router.get("/", knowledgeController.listKnowledge);

/** POST /api/v1/knowledge — add an entry to a businessId the caller manages. */
router.post("/", knowledgeController.createKnowledge);

/** GET /api/v1/knowledge/:entryId */
router.get("/:entryId", knowledgeController.getKnowledge);

/** PATCH /api/v1/knowledge/:entryId */
router.patch("/:entryId", knowledgeController.updateKnowledge);

/** DELETE /api/v1/knowledge/:entryId — archives (isActive=false). */
router.delete("/:entryId", knowledgeController.archiveKnowledge);

export default router;
