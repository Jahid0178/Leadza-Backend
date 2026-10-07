import { ExpressAuth } from "@auth/express";
import cors from "cors";
import express from "express";
import { pinoHttp } from "pino-http";
import { authConfig } from "./auth/auth";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/error";
import apiRoutes from "./routes";
import { logger } from "./utils/logger";

export function createApp() {
  const app = express();

  // Needed to detect the original protocol behind a TLS-terminating proxy.
  app.set("trust proxy", env.NODE_ENV === "production");
  app.disable("x-powered-by");

  // Credentialed CORS for the Next.js frontend (agent.md §10).
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
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

  // Versioned backend API (§40).
  app.use("/api/v1", apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
