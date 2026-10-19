import { paddleClient } from "../config/paddle";
import {
  findBillingCustomerForBusiness,
  listSubscriptionsForBusiness,
  listSubscriptionsForCustomer,
} from "../repositories/billing.repository";

/**
 * Paddle billing services (IMPLEMENTATION_PLAN Phase H).
 */

/**
 * Statuses that grant paid access.
 *
 * `active` and `trialing` both count. A `scheduled_change` (cancel/pause at
 * period end) is deliberately **not** consulted here: access is kept until the
 * subscription's `status` actually becomes `canceled`. `paused` and `past_due`
 * deny access.
 */
const ACCESS_GRANTING_STATUSES = new Set(["active", "trialing"]);

/**
 * Whether a mirrored Paddle subscription status grants paid access.
 *
 * Pure so the rule is unit-tested directly: `active`/`trialing` grant,
 * `paused`/`past_due`/`canceled` deny. A scheduled change is not a status and
 * therefore never reaches this decision.
 */
export function subscriptionStatusGrantsAccess(status: string): boolean {
  return ACCESS_GRANTING_STATUSES.has(status);
}

/** The subscription that grants access right now, if any. */
export async function findAccessGrantingSubscription(businessId: string) {
  const subscriptions = await listSubscriptionsForBusiness(businessId);
  return (
    subscriptions.find((subscription) =>
      subscriptionStatusGrantsAccess(subscription.status),
    ) ?? null
  );
}

/**
 * Whether the tenant currently has paid access, from mirrored state.
 *
 * Any granting subscription wins: a business that upgraded or re-subscribed
 * may legitimately hold more than one mirrored row (the old one canceled), so
 * "the latest row" would be the wrong question to ask.
 */
export async function businessHasPaidAccess(businessId: string): Promise<boolean> {
  return (await findAccessGrantingSubscription(businessId)) !== null;
}

/**
 * Mint a Paddle-hosted customer portal session for a tenant and return its
 * URL. Returns null when no Paddle customer is linked yet, so the caller can
 * answer 404 instead of leaking an SDK error.
 */
export async function createCustomerPortalSession(
  businessId: string,
): Promise<string | null> {
  const customer = await findBillingCustomerForBusiness(businessId);
  if (!customer) return null;

  const subscriptions = await listSubscriptionsForCustomer(customer.customerId);

  const session = await paddleClient().customerPortalSessions.create(
    customer.customerId,
    subscriptions.map((subscription) => subscription.subscriptionId),
  );

  return session.urls.general.overview;
}
