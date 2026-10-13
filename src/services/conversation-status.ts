/**
 * Backend-owned conversation lifecycle (FEATURES §19, §31, agent.md §19).
 *
 * The AI answers while AI_ACTIVE; a customer asking for a person moves the
 * thread to HUMAN_REQUESTED; staff taking over moves it to HUMAN_ACTIVE (the
 * AI stops), and either side can return it to AI_ACTIVE or close it. The
 * frontend may never jump a conversation to an arbitrary state — every change
 * is validated against this table (IMPLEMENTATION_PLAN step 15).
 */

export type ConversationStatus =
  | "AI_ACTIVE"
  | "HUMAN_REQUESTED"
  | "HUMAN_ACTIVE"
  | "CLOSED";

/** Outgoing transitions allowed from each status. */
export const CONVERSATION_STATUS_TRANSITIONS: Record<
  ConversationStatus,
  readonly ConversationStatus[]
> = {
  AI_ACTIVE: ["HUMAN_REQUESTED", "HUMAN_ACTIVE", "CLOSED"],
  HUMAN_REQUESTED: ["HUMAN_ACTIVE", "AI_ACTIVE", "CLOSED"],
  HUMAN_ACTIVE: ["AI_ACTIVE", "CLOSED"],
  // A closed thread can be reopened by a new inbound message.
  CLOSED: ["AI_ACTIVE"],
};

/**
 * Whether `from` → `to` is a valid transition. Setting the same status is a
 * valid no-op so PATCH stays idempotent.
 */
export function canTransitionConversation(
  from: ConversationStatus,
  to: ConversationStatus,
): boolean {
  if (from === to) return true;
  return CONVERSATION_STATUS_TRANSITIONS[from].includes(to);
}
