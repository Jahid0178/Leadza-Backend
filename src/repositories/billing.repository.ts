import { prisma } from "../lib/prisma";

/**
 * Paddle billing data access (IMPLEMENTATION_PLAN Phase H, agent.md §11).
 *
 * Every write here is an upsert keyed on the Paddle id, because webhook
 * deliveries are at-least-once and may arrive out of order: two replays of
 * `subscription.updated` must land on one row, and an older replay must not
 * resurrect a stale status over a newer one it cannot know about.
 */

export interface BillingCustomerInput {
  /** Paddle customer id (`ctm_…`). */
  customerId: string;
  email: string;
  /** Tenant to link, when it can be resolved; never clobbers a known link. */
  businessId?: string | null;
}

export async function upsertBillingCustomer(input: BillingCustomerInput) {
  const { customerId, email, businessId } = input;

  return prisma.paddleCustomer.upsert({
    where: { customerId },
    create: {
      customerId,
      email,
      businessId: businessId ?? null,
    },
    update: {
      email,
      // Only set the link when we actually resolved one — a later event that
      // could not resolve the tenant must not unlink a customer we matched.
      ...(businessId ? { businessId } : {}),
    },
  });
}

export interface SubscriptionInput {
  /** Paddle subscription id (`sub_…`). */
  subscriptionId: string;
  customerId: string;
  businessId?: string | null;
  status: string;
  priceId: string;
  productId: string;
  scheduledChangeAction?: string | null;
  scheduledChangeAt?: Date | null;
}

export async function upsertSubscription(input: SubscriptionInput) {
  const {
    subscriptionId,
    customerId,
    businessId,
    status,
    priceId,
    productId,
    scheduledChangeAction = null,
    scheduledChangeAt = null,
  } = input;

  return prisma.subscription.upsert({
    where: { subscriptionId },
    create: {
      subscriptionId,
      customerId,
      businessId: businessId ?? null,
      status,
      priceId,
      productId,
      scheduledChangeAction,
      scheduledChangeAt,
    },
    update: {
      status,
      priceId,
      productId,
      // `null` here is meaningful: it clears a scheduled change once Paddle
      // reports it is gone (e.g. after a resume).
      scheduledChangeAction,
      scheduledChangeAt,
      ...(businessId ? { businessId } : {}),
    },
  });
}

/** The billing customer linked to a tenant, if any. */
export async function findBillingCustomerForBusiness(businessId: string) {
  return prisma.paddleCustomer.findUnique({ where: { businessId } });
}

/** A billing customer by its Paddle id, if mirrored yet. */
export async function findBillingCustomer(customerId: string) {
  return prisma.paddleCustomer.findUnique({ where: { customerId } });
}

/** All mirrored subscriptions for a Paddle customer id. */
export async function listSubscriptionsForCustomer(customerId: string) {
  return prisma.subscription.findMany({
    where: { customerId },
    select: { subscriptionId: true },
  });
}

/** Every mirrored subscription for a tenant (used for access + display). */
export async function listSubscriptionsForBusiness(businessId: string) {
  return prisma.subscription.findMany({
    where: { businessId },
    orderBy: { updatedAt: "desc" },
  });
}

/**
 * Resolve the tenant a Paddle customer belongs to from their email, by
 * matching the (unique) platform user and taking their earliest business
 * membership. Used when a webhook carries no usable custom data.
 */
export async function findBusinessIdForEmail(email: string): Promise<string | null> {
  const membership = await prisma.businessMember.findFirst({
    where: { user: { email: { equals: email, mode: "insensitive" } } },
    orderBy: { createdAt: "asc" },
    select: { businessId: true },
  });
  return membership?.businessId ?? null;
}

/** Whether a business id actually exists — guards customer-supplied links. */
export async function businessExists(businessId: string): Promise<boolean> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { id: true },
  });
  return business !== null;
}
