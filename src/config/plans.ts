/**
 * Subscription plans and their usage limits (FEATURES §48,
 * IMPLEMENTATION_PLAN step 31).
 *
 * The Paddle catalog is the source of truth for **what was bought**; this file
 * is the source of truth for **what a plan allows**. A subscription's price id
 * is resolved to a tier here, so a webhook payload can never grant a limit by
 * naming one (agent.md §35: enforcement stays on the backend).
 *
 * The price ids below are the sandbox catalog mirrored in
 * `client/content/pricing.ts`. When the live catalog is created, add its six
 * ids here as well — an id this map does not know is treated as "limits not
 * enforced" (a verified payment must never be throttled by a mapping gap) and
 * logged by the usage service.
 *
 * Monthly limits reset on the 1st at 00:00 UTC. Yearly billing uses the same
 * monthly caps: the cycle changes how the customer pays, not what they may use.
 */

export type PlanId = "starter" | "pro" | "advanced";

/** The four metered quantities in FEATURES §48. */
export type UsageMetric =
  | "aiConversations"
  | "aiMessages"
  | "users"
  | "bookings";

export interface PlanLimits extends Record<UsageMetric, number> {
  /** Distinct conversations the AI answered this month. */
  aiConversations: number;
  /** AI-written replies this month. */
  aiMessages: number;
  /** Team members (current, not monthly). */
  users: number;
  /** Appointments created this month (cancelled ones do not count). */
  bookings: number;
}

export const PLAN_NAMES: Record<PlanId, string> = {
  starter: "Starter",
  pro: "Pro",
  advanced: "Advanced",
};

/**
 * Plan allowances.
 *
 * `aiMessages` is five replies per conversation, which leaves room for the
 * clarifying turns a qualification normally takes without letting one thread
 * consume a whole month's allowance.
 */
export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  starter: {
    aiConversations: 100,
    aiMessages: 500,
    users: 1,
    bookings: 0,
  },
  pro: {
    aiConversations: 500,
    aiMessages: 2_500,
    users: 5,
    bookings: 500,
  },
  advanced: {
    aiConversations: 1_500,
    aiMessages: 7_500,
    users: 15,
    bookings: 1_500,
  },
};

/**
 * Paddle price id → tier. Monthly and yearly prices of one product grant the
 * same plan.
 */
const PLAN_BY_PRICE_ID: Record<string, PlanId> = {
  // Starter
  "pri_01m5ath3h8q9njyqr2w38kedr0": "starter",
  "pri_01m5ath3v9qb4paq34mq2gp611": "starter",
  // Pro
  "pri_01m5ath57ttef7ysfxrb3p4s54": "pro",
  "pri_01m5ath5hnqzdpx18rt01s74a4": "pro",
  // Advanced
  "pri_01m5ath6602b6jn7mpcqydahe4": "advanced",
  "pri_01m5ath6f9wzaarxt41140a512": "advanced",
};

/**
 * The tier behind a Paddle price id, or null for an id this build does not
 * know (for example a price created after deployment). Callers treat null as
 * "do not enforce limits" and log it rather than guessing.
 */
export function planForPriceId(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  return PLAN_BY_PRICE_ID[priceId] ?? null;
}
