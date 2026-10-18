/**
 * Backend-owned booking lifecycle (FEATURES §35, IMPLEMENTATION_PLAN step 27).
 *
 * A booking starts PENDING (AI) or CONFIRMED (staff), can be confirmed from
 * PENDING, and ends as COMPLETED, NO_SHOW or CANCELLED. The frontend may never
 * jump a booking to an arbitrary state — every change is validated against
 * this table (agent.md §19).
 */

export type BookingStatus =
  | "PENDING"
  | "CONFIRMED"
  | "CANCELLED"
  | "COMPLETED"
  | "NO_SHOW";

/** Outgoing transitions allowed from each status. */
export const BOOKING_STATUS_TRANSITIONS: Record<
  BookingStatus,
  readonly BookingStatus[]
> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["COMPLETED", "NO_SHOW", "CANCELLED"],
  // Terminal outcomes — nothing leaves them.
  COMPLETED: [],
  NO_SHOW: [],
  CANCELLED: [],
};

/** Statuses that will never change again. */
export const TERMINAL_BOOKING_STATUSES: readonly BookingStatus[] = [
  "COMPLETED",
  "NO_SHOW",
  "CANCELLED",
];

/** Statuses that still occupy a calendar slot (see the partial unique index). */
export const ACTIVE_BOOKING_STATUSES: readonly BookingStatus[] = [
  "PENDING",
  "CONFIRMED",
];

/**
 * Whether `from` → `to` is a valid transition. Setting the same status is a
 * valid no-op so PATCH stays idempotent.
 */
export function canTransitionBooking(
  from: BookingStatus,
  to: BookingStatus,
): boolean {
  if (from === to) return true;
  return BOOKING_STATUS_TRANSITIONS[from].includes(to);
}
