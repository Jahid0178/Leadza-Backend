import { Router } from "express";
import { prisma } from "../lib/prisma";
import { apiError, apiSuccess } from "../utils/api-response";
import adminRoutes from "./admin.routes";
import authRoutes from "./auth.routes";
import businessRoutes from "./businesses.routes";
import geocodeRoutes from "./geocode.routes";
import serviceRoutes from "./services.routes";
import serviceAreaRoutes from "./servicearea.routes";
import businessHourRoutes from "./businesshour.routes";
import knowledgeRoutes from "./knowledge.routes";
import customerRoutes from "./customers.routes";
import leadRoutes from "./leads.routes";
import publicLeadRoutes from "./public-leads.routes";
import publicChatRoutes from "./public-chat.routes";
import conversationRoutes from "./conversations.routes";
import realtimeRoutes from "./realtime.routes";
import analyticsRoutes from "./analytics.routes";

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
router.use("/services", serviceRoutes);
router.use("/areas", serviceAreaRoutes);
router.use("/hours", businessHourRoutes);
router.use("/knowledge", knowledgeRoutes);
router.use("/customers", customerRoutes);
// Public website form (§21) — mounted BEFORE the authed /leads router so
// Express matches the unauthenticated path first (step 18).
router.use("/leads/public", publicLeadRoutes);
// Public website chat (§22, step 19) — unauthenticated embed, token-gated
// thread reads.
router.use("/chat/public", publicChatRoutes);
router.use("/leads", leadRoutes);
router.use("/conversations", conversationRoutes);
// Short-lived socket credentials (IMPLEMENTATION_PLAN step 38).
router.use("/realtime", realtimeRoutes);
router.use("/analytics", analyticsRoutes);

export default router;
