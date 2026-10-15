import { rateLimit } from "express-rate-limit";
import { Router, type NextFunction, type Request, type Response } from "express";
import * as publicLeadController from "../controllers/public-lead.controller";
import { apiError } from "../utils/api-response";

/**
 * /api/v1/leads/public — the unauthenticated website lead form
 * (FEATURES §21, IMPLEMENTATION_PLAN step 18).
 *
 * Mounted BEFORE the authed /leads router so Express matches it first.
 * No requireAuth: the caller is an anonymous visitor. Abuse controls are
 * the honeypot (controller) plus a per-IP rate limit via
 * express-rate-limit (§52); step 36 hardens both into the full bot-
 * protection pass.
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

const limiter = rateLimit({
  // Generous for humans (an impatient double-click fits easily), tight
  // enough that a single bot can't flood the lead table. The store is
  // per-process — acceptable for the MVP; step 36 moves it to a shared
  // store that survives restarts and multiple instances.
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // Keep the API's error envelope instead of the library's plain text
  // (agent.md §26 — consistent { success: false, error } everywhere).
  handler: (_req, res) => {
    res
      .status(429)
      .json(
        apiError(
          "RATE_LIMITED",
          "Too many enquiries from this address. Please wait a moment and try again.",
        ),
      );
  },
});

/** POST /api/v1/leads/public/:businessRef — capture an enquiry. */
router.post("/:businessRef", limiter, publicLeadController.submitPublicLead);

export default router;
