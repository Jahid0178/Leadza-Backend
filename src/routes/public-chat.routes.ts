import { rateLimit } from "express-rate-limit";
import { Router, type NextFunction, type Request, type Response } from "express";
import * as publicChatController from "../controllers/public-chat.controller";
import { apiError } from "../utils/api-response";

/**
 * /api/v1/chat/public — the unauthenticated website chat (FEATURES §22,
 * IMPLEMENTATION_PLAN step 19).
 *
 * Mounted before the authed routers so Express matches the public path first.
 * No requireAuth: the caller is an anonymous visitor. Thread reads are gated
 * by a per-thread access token header; abuse is bounded by the honeypot plus a
 * per-IP write limit (§52).
 */
const router = Router();

/**
 * Embed CORS (§21–22): the widget runs on whatever site the business embedded
 * it on, so any origin is reflected. No credentials are involved — the thread
 * token is a bearer value, not a cookie — so reflecting is safe. Mirrors the
 * public lead router; the installed cors build has no function-origin support,
 * so it is hand-rolled.
 */
function embedCors(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      (req.headers["access-control-request-headers"] as string) ||
        "content-type, x-chat-token",
    );
    // Expose nothing extra; the token header is request-only.
    res.setHeader("Access-Control-Max-Age", "600");
    res.status(204).end();
    return;
  }
  next();
}

router.use(embedCors);

/**
 * Writes are limited (a chat is chattier than a form, hence the larger budget
 * than the lead form's 10). Reads are polling-heavy — a widget checks a few
 * times per reply — so they are intentionally not limited here; the token gate
 * plus step 36's hardening cover abuse.
 */
const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res
      .status(429)
      .json(
        apiError(
          "RATE_LIMITED",
          "Too many messages from this address. Please wait a moment and try again.",
        ),
      );
  },
});

/** GET /status — AI availability + business name for the widget header. */
router.get("/:businessRef/status", publicChatController.getChatStatus);

/**
 * Typing pings carry no content and arrive while a visitor is composing, so
 * they get their own generous budget — the message limiter (40 / 10 min) is
 * far too low for someone mid-sentence.
 */
const typingLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 400,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).end();
  },
});

/** POST /:businessRef/typing — the visitor is typing (ephemeral, §22). */
router.post(
  "/:businessRef/typing",
  typingLimiter,
  publicChatController.postChatTyping,
);

/** POST / — send a message (starts the thread on the first one). */
router.post("/:businessRef", writeLimiter, publicChatController.postChatMessage);

/** GET /:conversationId/messages — poll the thread. */
router.get(
  "/:businessRef/:conversationId/messages",
  publicChatController.getChatMessages,
);

export default router;
