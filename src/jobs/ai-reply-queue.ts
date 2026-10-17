import { runLeadAgent } from "../agents/lead-agent";
import { logger } from "../utils/logger";
import { JobQueue } from "./queue";

/**
 * The AI reply queue (IMPLEMENTATION_PLAN step 20, agent.md §24).
 *
 * Public lead capture and inbound channel webhooks enqueue a conversation
 * here instead of calling the model inline, so a slow or failing provider
 * never delays a customer's submission (§59).
 *
 * Jobs are keyed by conversation id: a second message for a thread that is
 * already being answered does not start a second model call. A provider
 * failure (status "failed") is thrown so the queue retries with backoff; a
 * "skipped" result — disabled provider, human takeover, nothing to answer —
 * is a normal outcome and is not retried.
 */
const queue = new JobQueue<string>({
  name: "ai-reply",
  keyOf: (conversationId) => `ai-reply:${conversationId}`,
  concurrency: 1,
  maxAttempts: 3,
  retryDelayMs: 2000,
  handler: async (conversationId) => {
    const result = await runLeadAgent(conversationId);
    if (result.status === "failed") {
      throw new Error(
        `AI reply failed (${result.reason ?? "unknown"}) for conversation ${conversationId}`,
      );
    }
  },
});

/** Queue the agent to answer the latest customer message in a conversation. */
export function enqueueAiReply(conversationId: string): void {
  const accepted = queue.enqueueLatest(conversationId);
  if (!accepted) {
    logger.debug(
      { conversationId },
      "AI reply already running — scheduled a follow-up run",
    );
  }
}

/** Start processing (called once at boot, not in tests/dev harnesses). */
export function startAiReplyQueue(): void {
  queue.start();
}

/** Stop processing and drop pending jobs (graceful shutdown). */
export function stopAiReplyQueue(): void {
  queue.stop();
}

/** Resolve when the queue is idle — used by tests. */
export function drainAiReplyQueue(): Promise<void> {
  return queue.drain();
}

/** Jobs currently waiting — observability/tests. */
export function aiReplyQueueDepth(): number {
  return queue.pending;
}
