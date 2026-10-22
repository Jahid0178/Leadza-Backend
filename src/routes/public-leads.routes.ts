import { Router, type NextFunction, type Request, type Response } from "express";
import * as publicLeadController from "../controllers/public-lead.controller";
import { rateLimiter } from "../middleware/rate-limit";

/**
 * /api/v1/leads/public — the unauthenticated website lead form
 * (FEATURES §21, IMPLEMENTATION_PLAN step 18).
 *
 * Mounted BEFORE the authed /leads router so Express matches the unauthenticated
 * path first. No requireAuth: the caller is an anonymous visitor. Abuse controls
 * are the honeypot (controller) plus a per-IP rate limit through the shared
 * limiter factory (§52, step 36 — shared Upstash store when configured).
 */
const router = Router();

/**
 * Embed CORS (§21): the widget posts from whatever site the business
 * embedded it on, so any origin is reflected. No credentials involved —
 * an anonymous visitor sends none — so reflecting is safe. Hand-rolled
 * because the installed cors build only supports static origins, and a
 * second cors() later in the chain would overwrite this header.
 */
function embedCors(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      (req.headers["access-control-request-headers"] as string) || "content-type",
    );
    // Short and cacheable — preflights shouldn't double the rate-limit cost.
    res.setHeader("Access-Control-Max-Age", "600");
    res.status(204).end();
    return;
  }
  next();
}

router.use(embedCors);

const limiter = rateLimiter({
  // Generous for humans (an impatient double-click fits easily), tight
  // enough that a single bot can't flood the lead table. Counters live in
  // the shared store when Upstash is configured (step 36).
  name: "public-lead",
  windowMs: 10 * 60 * 1000,
  limit: 10,
  message: "Too many enquiries from this address. Please wait a moment and try again.",
});

/** POST /api/v1/leads/public/:businessRef — capture an enquiry. */
router.post("/:businessRef", limiter, publicLeadController.submitPublicLead);

export default router;
