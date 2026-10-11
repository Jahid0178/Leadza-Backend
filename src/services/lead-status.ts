/**
 * Backend-owned lead lifecycle (FEATURES §15, agent.md §19).
 *
 * The flow is NEW → CONTACTED → QUALIFYING → QUALIFIED → BOOKED → WON with
 * LOST / SPAM / CANCELLED as alternative outcomes. The frontend may never
 * jump a lead to an arbitrary state — every status change is validated
 * against this table (agent.md §19, IMPLEMENTATION_PLAN step 14).
 */

export type LeadStatus =
  | "NEW"
  | "CONTACTED"
  | "QUALIFYING"
  | "QUALIFIED"
  | "BOOKED"
  | "WON"
  | "LOST"
  | "SPAM"
  | "CANCELLED";

/** Outgoing transitions allowed from each status. */
export const LEAD_STATUS_TRANSITIONS: Record<LeadStatus, readonly LeadStatus[]> = {
  NEW: ["CONTACTED", "QUALIFYING", "SPAM", "CANCELLED", "LOST"],
  CONTACTED: ["QUALIFYING", "QUALIFIED", "SPAM", "CANCELLED", "LOST"],
  QUALIFYING: ["QUALIFIED", "SPAM", "CANCELLED", "LOST"],
  QUALIFIED: ["BOOKED", "CANCELLED", "LOST"],
  BOOKED: ["WON", "CANCELLED", "LOST"],
  // Terminal outcomes — nothing leaves them.
  WON: [],
  LOST: [],
  SPAM: [],
  CANCELLED: [],
};

/** Statuses that will never change again. */
export const TERMINAL_LEAD_STATUSES: readonly LeadStatus[] = [
  "WON",
  "LOST",
  "SPAM",
  "CANCELLED",
];

/**
 * Whether `from` → `to` is a valid transition. Setting the same status is a
 * valid no-op so PATCH stays idempotent.
 */
export function canTransitionLead(from: LeadStatus, to: LeadStatus): boolean {
  if (from === to) return true;
  return LEAD_STATUS_TRANSITIONS[from].includes(to);
}
