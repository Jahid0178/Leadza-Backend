import { ExpressAuth } from "@auth/express";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { authConfig } from "./auth/auth";
import { env, TRUST_PROXY_HOPS } from "./config/env";
import { paddleWebhook } from "./controllers/paddle.controller";
import { errorHandler, notFoundHandler } from "./middleware/error";
import apiRoutes from "./routes";
import widgetRoutes from "./routes/widget.routes";
import { logger } from "./utils/logger";

export function createApp() {
  const app = express();

  // Trust exactly the documented proxy chain (step 36): trusting every hop
  // would let a client forge `X-Forwarded-For` and defeat the per-IP rate
  // limiters (§52). TRUST_PROXY_HOPS defaults to 1 in production (behind one
  // TLS-terminating proxy), 0 when served directly.
  app.set("trust proxy", TRUST_PROXY_HOPS);
  app.disable("x-powered-by");

  // Security headers (§52, step 36): HSTS, nosniff, frame protection and
  // referrer policy from helmet. CSP and COEP stay off — this process serves
  // JSON and /widget.js, and the widget answers to whatever page embeds it,
  // so a restrictive default here could only break nothing while implying a
  // policy the API does not enforce.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

  // Credentialed CORS for the Next.js frontend (agent.md §10). The public
  // lead form (§21) is excluded here: it is submitted from the business's
  // own website, so its router answers CORS itself with a reflected
  // origin (and no credentials). Skipping it matters — a second cors()
  // with a fixed origin would overwrite the reflected header on the
  // actual POST (only preflights are answered and ended by the first
  // middleware), and the installed cors build has no function-origin
  // support to express both policies in one instance.
  app.use((req, res, next) => {
    // Both public embed routers (§21 lead form, §22 chat) answer CORS
    // themselves with a reflected origin and no credentials.
    if (
      req.path.startsWith("/api/v1/leads/public") ||
      req.path.startsWith("/api/v1/chat/public")
    ) {
      next();
      return;
    }
    cors({ origin: env.CORS_ORIGIN, credentials: true })(req, res, next);
  });

  // Paddle webhooks are verified against the RAW body, so this route must be
  // mounted before express.json() — a parsed body fails signature
  // verification. (Phase H, Part 1.)
  app.post(
    "/api/v1/paddle/webhook",
    express.raw({ type: "application/json" }),
    paddleWebhook,
  );

  app.use(express.json());

  // Structured request logs: request id, method, url, status, duration (§37).
  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => req.url === "/api/v1/health",
      },
    }),
  );

  // Auth.js standard endpoints: /api/auth/session, /csrf, /callback/*, /signout (§5).
  app.use("/api/auth", ExpressAuth(authConfig));

  // Embeddable website widget (§21) — served at the API root so the
  // business snippet matches the spec example (step 18).
  app.use(widgetRoutes);

  // Versioned backend API (§40).
  app.use("/api/v1", apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
