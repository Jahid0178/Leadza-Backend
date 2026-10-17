import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import * as realtimeController from "../controllers/realtime.controller";

/**
 * /api/v1/realtime — realtime socket credentials (IMPLEMENTATION_PLAN step 38).
 *
 * Only mints a short-lived token; the socket itself lives on the HTTP server
 * (src/realtime/server.ts). Authentication first (agent.md §34).
 */
const router = Router();

router.use(requireAuth);

/** POST /api/v1/realtime/token — a fresh socket credential for the caller. */
router.post("/token", realtimeController.createToken);

export default router;
