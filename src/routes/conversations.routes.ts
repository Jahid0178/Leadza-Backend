import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import * as conversationController from "../controllers/conversation.controller";

/**
 * /api/v1/conversations — membership-scoped conversation resources
 * (FEATURES §19, §31–32, IMPLEMENTATION_PLAN steps 15–16). The tenant scope is
 * resolved server-side from the authenticated user, never from a trusted
 * client-supplied businessId (§7, §52). Status changes only go through the
 * dedicated status endpoint, validated by the backend transition table
 * (agent.md §19).
 *
 * Order per §34: authentication → validation → controller (authorization
 * lives in the controller so item routes can answer 403 vs 404 correctly).
 */
const router = Router();

router.use(requireAuth);

/** GET /api/v1/conversations — filters: status, channel, assignee, search. */
router.get("/", conversationController.listConversations);

/** POST /api/v1/conversations — open a thread for a customer. */
router.post("/", conversationController.createConversation);

/** GET /api/v1/conversations/:conversationId — detail with message history. */
router.get("/:conversationId", conversationController.getConversation);

/** PATCH /api/v1/conversations/:conversationId/status — validated transition. */
router.patch("/:conversationId/status", conversationController.changeConversationStatus);

/** POST /api/v1/conversations/:conversationId/messages — staff reply (§32). */
router.post("/:conversationId/messages", conversationController.appendMessage);

/** POST /api/v1/conversations/:conversationId/typing — "I'm typing…" (§22). */
router.post("/:conversationId/typing", conversationController.setConversationTyping);

export default router;
