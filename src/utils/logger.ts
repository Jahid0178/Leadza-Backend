import pino from "pino";
import { env } from "../config/env";

/**
 * Structured backend logging (agent.md §37).
 * Never log passwords, API keys, session secrets, or payment secrets.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "server" },
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.passwordHash"],
    censor: "[REDACTED]",
  },
});
