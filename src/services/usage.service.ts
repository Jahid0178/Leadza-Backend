import {
  PLAN_LIMITS,
  PLAN_NAMES,
  planForPriceId,
  type PlanId,
  type UsageMetric,
} from "../config/plans";
import {
  conversationHasAiMessage,
  countAiConversations,
  countAiMessages,
  countUsageForBusiness,
  countUsageMetric,
  type UsagePeriod,
} from "../repositories/usage.repository";
import { ApiError } from "../utils/api-error";
import { logger } from "../utils/logger";
import { findAccessGrantingSubscription } from "./paddle-billing";

/**
 * Usage-limit pre-flight (FEATURES §48, IMPLEMENTATION_PLAN step 31).
 *
 * The pipeline every billable operation follows is:
 *
 *   authenticate → identify business (membership) → load subscription
 *     → check usage → allow / reject
 *
 * Authentication and membership already happen in the route layer; this module
 * owns the last three steps. It is the only place a plan allowance is read, so
 * the AI pipeline, booking writes and the usage dashboard can never disagree
 * about what a plan allows.
 *
 * Failure codes (safe to show, agent.md §25):
 *   SUBSCRIPTION_REQUIRED — no active/trialing subscription
 *   USAGE_LIMIT_REACHED   — the plan's allowance is exhausted
 */

export const SUBSCRIPTION_REQUIRED = "SUBSCRIPTION_REQUIRED";
export const USAGE_LIMIT_REACHED = "USAGE_LIMIT_REACHED";

export const USAGE_METRIC_LABELS: Record<UsageMetric, string> = {
  aiConversations: "AI conversations",
  aiMessages: "AI messages",
  users: "Team members",
  bookings: "Bookings",
};

/** Singular nouns for refusal messages ("this month's AI message limit"). */
const USAGE_METRIC_NOUNS: Record<UsageMetric, string> = {
  aiConversations: "AI conversation",
  aiMessages: "AI message",
  users: "team member",
  bookings: "booking",
};

/**
 * One warning per unknown price id per process, not one per AI run or page
 * view. A verified payment fails open (see `checkUsage`), and operators need a
 * visible signal that the catalog needs the live id.
 */
const warnedUnknownPriceIds = new Set<string>();

function warnUnknownPlan(priceId: string | null, businessId: string): void {
  if (!priceId || warnedUnknownPriceIds.has(priceId)) return;
  warnedUnknownPriceIds.add(priceId);
  logger.warn(
    { priceId, businessId },
    "Active subscription price is not in the plan catalog — usage limits not enforced",
  );
}

/** The monthly window: 1st 00:00 UTC to the 1st of the next month. */
export function currentUsagePeriod(now: Date = new Date()): UsagePeriod {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

export interface UsageMetricView {
  key: UsageMetric;
  label: string;
  used: number;
  /** Null when the subscription's price is not in this build's catalog. */
  limit: number | null;
  remaining: number | null;
  reached: boolean;
}

export interface UsageSummary {
  plan: PlanId | null;
  planName: string | null;
  subscriptionActive: boolean;
  /** False when no plan is known, so nothing is capped. */
  limitsEnforced: boolean;
  period: { start: string; end: string };
  metrics: UsageMetricView[];
}

/**
 * Everything the billing page and dashboard banner need, for one tenant.
 *
 * Counts are read even when no limit applies, so a business that subscribes
 * mid-month immediately sees the usage it has already built up.
 */
export async function readUsage(
  businessId: string,
  now: Date = new Date(),
): Promise<UsageSummary> {
  const period = currentUsagePeriod(now);
  const subscription = await findAccessGrantingSubscription(businessId);
  const plan = subscription ? planForPriceId(subscription.priceId) : null;
  if (subscription && !plan) warnUnknownPlan(subscription.priceId, businessId);
  const counts = await countUsageForBusiness(businessId, period);

  const metrics = (Object.keys(USAGE_METRIC_LABELS) as UsageMetric[]).map(
    (key): UsageMetricView => {
      const used = counts[key];
      const limit = plan ? PLAN_LIMITS[plan][key] : null;
      return {
        key,
        label: USAGE_METRIC_LABELS[key],
        used,
        limit,
        remaining: limit === null ? null : Math.max(limit - used, 0),
        reached: limit !== null && used >= limit,
      };
    },
  );

  return {
    plan,
    planName: plan ? PLAN_NAMES[plan] : null,
    subscriptionActive: subscription !== null,
    limitsEnforced: plan !== null,
    period: {
      start: period.start.toISOString(),
      end: period.end.toISOString(),
    },
    metrics,
  };
}

/** Allow or deny one metered operation. Never throws. */
export type UsageDecision =
  | {
      allowed: true;
      metric: UsageMetric;
      used: number;
      /** Null when the active price is unknown, so nothing is capped. */
      limit: number | null;
      remaining: number | null;
    }
  | { allowed: false; reason: "subscription_required" }
  | {
      allowed: false;
      reason: "limit_reached";
      metric: UsageMetric;
      used: number;
      limit: number;
    };

/**
 * Pre-flight for one operation.
 *
 * An active subscription whose price id is not in the catalog fails **open**:
 * Paddle verified the payment, and a deployment that forgot to add a live price
 * must not silently stop a paying customer's business. The condition is logged
 * once per price id and surfaced as `limitsEnforced: false` in the usage
 * summary, and documented in the implementation plan.
 */
export async function checkUsage(
  businessId: string,
  metric: UsageMetric,
  now: Date = new Date(),
): Promise<UsageDecision> {
  const subscription = await findAccessGrantingSubscription(businessId);
  if (!subscription) return { allowed: false, reason: "subscription_required" };

  const plan = planForPriceId(subscription.priceId);
  if (!plan) {
    warnUnknownPlan(subscription.priceId, businessId);
    return { allowed: true, metric, used: 0, limit: null, remaining: null };
  }

  const period = currentUsagePeriod(now);
  const used = await countUsageMetric(businessId, metric, period);
  const limit = PLAN_LIMITS[plan][metric];

  if (used >= limit) {
    return { allowed: false, reason: "limit_reached", metric, used, limit };
  }

  return { allowed: true, metric, used, limit, remaining: limit - used };
}

/** Message for a business that has no active subscription. */
export function subscriptionRequiredMessage(metric: UsageMetric): string {
  switch (metric) {
    case "bookings":
      return "An active subscription is required to book appointments.";
    case "users":
      return "An active subscription is required to add team members.";
    default:
      return "An active subscription is required to use the AI assistant.";
  }
}

/** Message naming the exhausted allowance, so the next step is obvious. */
export function limitReachedMessage(
  metric: UsageMetric,
  limit: number,
): string {
  if (metric === "users") {
    return `You've reached your plan's team member limit (${limit}). Upgrade to add more people.`;
  }
  if (metric === "bookings" && limit === 0) {
    return "Appointment booking isn't included in your current plan. Upgrade to start booking.";
  }
  return `You've reached this month's ${USAGE_METRIC_NOUNS[metric]} limit (${limit}). Upgrade your plan to continue.`;
}

/**
 * Throw the typed failure for a refused operation. Controllers call this after
 * membership has been verified; repositories use `checkUsage` directly when
 * they need to return a refusal instead of throwing (for example the AI tool
 * path).
 */
export async function assertUsage(
  businessId: string,
  metric: UsageMetric,
  now: Date = new Date(),
): Promise<void> {
  const decision = await checkUsage(businessId, metric, now);
  if (decision.allowed) return;

  if (decision.reason === "subscription_required") {
    throw ApiError.forbidden(
      SUBSCRIPTION_REQUIRED,
      subscriptionRequiredMessage(metric),
    );
  }

  throw ApiError.conflict(
    USAGE_LIMIT_REACHED,
    limitReachedMessage(decision.metric, decision.limit),
  );
}

/** Outcome of the AI-specific pre-flight. */
export type AiRunCheck =
  | { allowed: true; plan: PlanId | null; limitsEnforced: boolean }
  | { allowed: false; reason: "subscription_required" }
  | {
      allowed: false;
      reason: "limit_reached";
      metric: "aiConversations" | "aiMessages";
      used: number;
      limit: number;
    };

/**
 * May the agent answer this conversation right now?
 *
 * A thread that already had an AI reply this month is already part of the
 * conversation count, so a follow-up does not consume a second allowance. The
 * message cap is checked separately and stops the run even inside a counted
 * thread.
 *
 * Called from `runLeadAgent` before the model call, so an exhausted plan never
 * costs a provider request. `conversationId` is optional: the public widget
 * asks "could a new conversation start?" without one.
 */
export async function checkAiRun(
  businessId: string,
  conversationId: string | null,
  now: Date = new Date(),
): Promise<AiRunCheck> {
  const subscription = await findAccessGrantingSubscription(businessId);
  if (!subscription) return { allowed: false, reason: "subscription_required" };

  const plan = planForPriceId(subscription.priceId);
  if (!plan) {
    warnUnknownPlan(subscription.priceId, businessId);
    return { allowed: true, plan: null, limitsEnforced: false };
  }

  const period = currentUsagePeriod(now);
  const limits = PLAN_LIMITS[plan];

  const [messages, conversations, alreadyCounted] = await Promise.all([
    countAiMessages(businessId, period),
    countAiConversations(businessId, period),
    conversationId
      ? conversationHasAiMessage(conversationId, period)
      : Promise.resolve(false),
  ]);

  if (messages >= limits.aiMessages) {
    return {
      allowed: false,
      reason: "limit_reached",
      metric: "aiMessages",
      used: messages,
      limit: limits.aiMessages,
    };
  }

  if (!alreadyCounted && conversations >= limits.aiConversations) {
    return {
      allowed: false,
      reason: "limit_reached",
      metric: "aiConversations",
      used: conversations,
      limit: limits.aiConversations,
    };
  }

  return { allowed: true, plan, limitsEnforced: true };
}

/**
 * Whether the website widget may open a conversational thread. Used by the
 * public status endpoint so an exhausted plan quietly falls back to the
 * enquiry form instead of showing a chat that can never answer.
 */
export async function isAiAvailableForBusiness(
  businessId: string,
): Promise<boolean> {
  return (await checkAiRun(businessId, null)).allowed;
}
