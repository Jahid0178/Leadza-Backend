/**
 * Queue the AI agent to answer a new conversation (§21 flow, step 18 → 20).
 *
 * The agent itself lands in IMPLEMENTATION_PLAN step 20 and must run as a
 * background job, never inside the HTTP request (§59). Until then this is
 * a documented no-op: the conversation is created in AI_ACTIVE, shows on
 * the dashboard and in /conversations, so wiring the real queue later only
 * touches this module.
 */
export async function triggerAiReply(_conversationId: string): Promise<void> {
  // Intentionally empty until step 20 — see doc comment.
}
