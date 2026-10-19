import { prisma } from "../../src/lib/prisma";

/**
 * Billing fixtures for tests (IMPLEMENTATION_PLAN step 31).
 *
 * Metered operations now require an active subscription. Tests that predate
 * usage limits still exercise real AI runs and bookings, so they grant a plan
 * up front instead of weakening production behaviour.
 *
 * Ids are derived from the business id, so repeated runs converge on the same
 * customer/subscription rows.
 */

/** Sandbox price ids — keep in sync with `src/config/plans.ts`. */
export const PLAN_PRICE = {
  starter: "pri_01m5ath3h8q9njyqr2w38kedr0",
  pro: "pri_01m5ath57ttef7ysfxrb3p4s54",
  advanced: "pri_01m5ath6602b6jn7mpcqydahe4",
} as const;

export type TestPlan = keyof typeof PLAN_PRICE;

/** Give a business an active subscription on the requested plan. */
export async function grantPlan(
  businessId: string,
  plan: TestPlan = "pro",
  status = "active",
): Promise<{ customerId: string; subscriptionId: string; priceId: string }> {
  const customerId = `ctm_test_${businessId}`;
  const subscriptionId = `sub_test_${businessId}`;
  const priceId = PLAN_PRICE[plan];

  await prisma.paddleCustomer.upsert({
    where: { customerId },
    create: {
      customerId,
      email: `${businessId}@plan.test`,
      businessId,
    },
    update: { businessId },
  });

  await prisma.subscription.upsert({
    where: { subscriptionId },
    create: {
      subscriptionId,
      customerId,
      businessId,
      status,
      priceId,
      productId: `pro_test_${businessId}`,
    },
    update: { businessId, status, priceId },
  });

  return { customerId, subscriptionId, priceId };
}
