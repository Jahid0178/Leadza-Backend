import { ExpressAuth } from "@auth/express";
import cors from "cors";
import express from "express";
import { pinoHttp } from "pino-http";
import { authConfig } from "./auth/auth";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/error";
import apiRoutes from "./routes";
import widgetRoutes from "./routes/widget.routes";
import { logger } from "./utils/logger";

export function createApp() {
  const app = express();

  // Needed to detect the original protocol behind a TLS-terminating proxy.
  app.set("trust proxy", env.NODE_ENV === "production");
  app.disable("x-powered-by");

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
