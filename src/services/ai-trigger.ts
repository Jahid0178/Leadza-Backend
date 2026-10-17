import { enqueueAiReply } from "../jobs/ai-reply-queue";

/**
 * Hand a conversation to the AI agent (IMPLEMENTATION_PLAN step 20).
 *
 * The call is fire-and-forget on purpose: it only puts the job on the
 * in-process queue and returns immediately, so the HTTP request that captured
 * the enquiry is never held open while a model is called (agent.md §24, §59).
 * The old no-op stub lived here until the agent landed; callers did not change.
 */
export function triggerAiReply(conversationId: string): void {
  enqueueAiReply(conversationId);
}
