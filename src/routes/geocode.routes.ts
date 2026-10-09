import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import * as geocodeController from "../controllers/geocode.controller";

/**
 * /api/v1/geocode — address search proxy (Nominatim, agent.md §3, §49).
 * Gated router-wide: anonymous callers get 401 before reaching the upstream,
 * so the public Nominatim instance is never reachable through us
 * unauthenticated.
 */
const router = Router();

router.use(requireAuth);

router.get("/search", geocodeController.search);

export default router;
