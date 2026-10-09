import { Router } from "express";
import { prisma } from "../lib/prisma";
import { apiError, apiSuccess } from "../utils/api-response";
import adminRoutes from "./admin.routes";
import authRoutes from "./auth.routes";
import businessRoutes from "./businesses.routes";
import geocodeRoutes from "./geocode.routes";

const router = Router();

/** GET /api/v1/health — liveness + database reachability. */
router.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json(
      apiSuccess({ status: "ok", database: "up", timestamp: new Date().toISOString() }),
    );
  } catch {
    res
      .status(503)
      .json(apiError("DATABASE_UNAVAILABLE", "The service is temporarily unavailable."));
  }
});

router.use("/auth", authRoutes);
router.use("/admin", adminRoutes);
router.use("/businesses", businessRoutes);
router.use("/geocode", geocodeRoutes);

export default router;
