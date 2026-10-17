import { createApp } from "./app";
import { env } from "./config/env";
import { startAiReplyQueue, stopAiReplyQueue } from "./jobs/ai-reply-queue";
import { attachRealtimeServer, closeRealtimeServer } from "./realtime/server";
import { logger } from "./utils/logger";

const app = createApp();

// Background jobs (AI replies) run in-process, outside any HTTP request
// (agent.md §24, §59). Started only here so tests and scripts stay in control.
startAiReplyQueue();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "server listening");
});

// Dashboard realtime updates ride on the same HTTP server (§38).
attachRealtimeServer(server);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down");
    stopAiReplyQueue();
    void closeRealtimeServer().finally(() => {
      server.close(() => process.exit(0));
    });
  });
}
