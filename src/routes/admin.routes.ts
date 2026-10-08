import { Router } from "express";
import { requireAuth, requirePlatformAdmin } from "../auth/middleware";
import * as adminController from "../controllers/admin.controller";

/**
 * /api/v1/admin — every endpoint requires an authenticated PLATFORM_ADMIN
 * (agent.md §Platform Admin Security). The gate runs router-wide so even
 * unmatched admin paths answer 403 to non-admins instead of revealing
 * which routes exist.
 */
const router = Router();

router.use(requireAuth, requirePlatformAdmin);

router.get("/status", adminController.status);

export default router;
