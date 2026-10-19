import type { UsageMetric } from "../config/plans";
import { prisma } from "../lib/prisma";

/**
 * Usage metering (FEATURES §48, IMPLEMENTATION_PLAN step 31).
 *
 * Every quantity is **derived from the rows the platform already stores**, so
 * there is no counter to drift out of sync with the data it describes:
 *
 *   AI conversations — distinct conversations with an AI-written message in
 *                      the period (a thread only counts once per month);
 *   AI messages      — AI-written messages in the period;
 *   users            — current memberships (not monthly);
 *   bookings         — non-cancelled bookings created in the period.
 *
 * Every query is scoped by a verified `businessId`; the repository never
 * accepts a tenant from the request (§7, §13, §52).
 */

export interface UsagePeriod {
  /** Inclusive start of the window. */
  start: Date;
  /** Exclusive end of the window. */
  end: Date;
}

/** Distinct conversations the AI answered inside the period. */
export async function countAiConversations(
  businessId: string,
  period: UsagePeriod,
): Promise<number> {
  const conversations = await prisma.message.groupBy({
    by: ["conversationId"],
    where: {
      aiGenerated: true,
      conversation: { businessId },
      createdAt: { gte: period.start, lt: period.end },
    },
  });
  return conversations.length;
}

/** AI-written replies inside the period. */
export async function countAiMessages(
  businessId: string,
  period: UsagePeriod,
): Promise<number> {
  return prisma.message.count({
    where: {
      aiGenerated: true,
      conversation: { businessId },
      createdAt: { gte: period.start, lt: period.end },
    },
  });
}

/** Current team members — a plan cap, not a monthly allowance. */
export async function countMembers(businessId: string): Promise<number> {
  return prisma.businessMember.count({ where: { businessId } });
}

/**
 * Bookings created inside the period. A cancelled appointment releases its
 * slot and does not consume the allowance, so a customer can rebook.
 */
export async function countBookings(
  businessId: string,
  period: UsagePeriod,
): Promise<number> {
  return prisma.booking.count({
    where: {
      businessId,
      createdAt: { gte: period.start, lt: period.end },
      status: { not: "CANCELLED" },
    },
  });
}

/**
 * Whether this conversation has already been metered as an AI conversation in
 * the period. A follow-up in an existing thread must not consume a second
 * conversation allowance.
 */
export async function conversationHasAiMessage(
  conversationId: string,
  period: UsagePeriod,
): Promise<boolean> {
  const message = await prisma.message.findFirst({
    where: {
      conversationId,
      aiGenerated: true,
      createdAt: { gte: period.start, lt: period.end },
    },
    select: { id: true },
  });
  return message !== null;
}

/** Every metered quantity for the usage dashboard. */
export async function countUsageForBusiness(
  businessId: string,
  period: UsagePeriod,
): Promise<Record<UsageMetric, number>> {
  const [aiConversations, aiMessages, users, bookings] = await Promise.all([
    countAiConversations(businessId, period),
    countAiMessages(businessId, period),
    countMembers(businessId),
    countBookings(businessId, period),
  ]);

  return { aiConversations, aiMessages, users, bookings };
}

/** One quantity — used by a pre-flight check to avoid counting the rest. */
export async function countUsageMetric(
  businessId: string,
  metric: UsageMetric,
  period: UsagePeriod,
): Promise<number> {
  switch (metric) {
    case "aiConversations":
      return countAiConversations(businessId, period);
    case "aiMessages":
      return countAiMessages(businessId, period);
    case "users":
      return countMembers(businessId);
    case "bookings":
      return countBookings(businessId, period);
  }
}
