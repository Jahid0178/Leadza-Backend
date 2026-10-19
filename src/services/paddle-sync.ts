import {
  ApiError,
  type Subscription as PaddleSubscription,
} from "@paddle/paddle-node-sdk";
import { paddleClient } from "../config/paddle";
import {
  businessExists,
  findBillingCustomer,
  findBillingCustomerForBusiness,
  upsertBillingCustomer,
  upsertSubscription,
} from "../repositories/billing.repository";
import { logger } from "../utils/logger";

/**
 * Paddle reconciliation (IMPLEMENTATION_PLAN Phase H).
 *
 * Webhooks are the primary source of truth, but they require a publicly
 * reachable HTTPS endpoint. Until that exists (and as a safety net afterwards,
 * because deliveries can be missed), this reads the same state straight from
 * the Paddle API and mirrors it through the same idempotent upserts.
 *
 * It never trusts a client-supplied Paddle id: a transaction is only accepted
 * when it names this tenant in `custom_data`, or when its customer email
 * matches the signed-in user.
 */

export type ReconcileOutcome =
  | { status: "ok"; subscriptionsMirrored: number }
  | { status: "not_found" }
  | { status: "no_purchase" };

function readBusinessId(customData: unknown): string | null {
  if (typeof customData !== "object" || customData === null) return null;
  const value = (customData as Record<string, unknown>).businessId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Mirror a Paddle customer, linking it to the tenant when possible.
 *
 * A customer already linked to another tenant is never moved, and a tenant
 * that already has a billing customer is never reassigned — the unique
 * constraint on `business_id` enforces that at the database level too.
 */
async function linkCustomer(
  customerId: string,
  email: string | null,
  businessId: string | null,
): Promise<string> {
  const existing = await findBillingCustomer(customerId);

  if (existing) {
    if (businessId && !existing.businessId) {
      const occupying = await findBillingCustomerForBusiness(businessId);
      if (!occupying || occupying.customerId === customerId) {
        await upsertBillingCustomer({
          customerId,
          email: existing.email,
          businessId,
        });
      }
    }
    return existing.email;
  }

  const resolvedEmail =
    email ?? (await paddleClient().customers.get(customerId)).email;

  let nextBusinessId = businessId;
  if (nextBusinessId) {
    const occupying = await findBillingCustomerForBusiness(nextBusinessId);
    if (occupying && occupying.customerId !== customerId) nextBusinessId = null;
  }

  await upsertBillingCustomer({
    customerId,
    email: resolvedEmail,
    businessId: nextBusinessId,
  });

  return resolvedEmail;
}

/** Mirror one Paddle subscription (and its customer) into our tables. */
async function mirrorSubscription(
  subscription: PaddleSubscription,
  businessId: string | null,
): Promise<boolean> {
  const item = subscription.items.find((candidate) => candidate.price?.id);
  if (!item) return false;

  const priceId = item.price.id;
  const productId = item.product?.id ?? item.price.productId;
  if (!priceId || !productId) return false;

  const fromCustomData = readBusinessId(subscription.customData);
  const resolvedBusinessId =
    businessId ??
    (fromCustomData && (await businessExists(fromCustomData))
      ? fromCustomData
      : null);

  await linkCustomer(subscription.customerId, null, resolvedBusinessId);

  await upsertSubscription({
    subscriptionId: subscription.id,
    customerId: subscription.customerId,
    businessId: resolvedBusinessId,
    status: subscription.status,
    priceId,
    productId,
    scheduledChangeAction: subscription.scheduledChange?.action ?? null,
    scheduledChangeAt: subscription.scheduledChange?.effectiveAt
      ? new Date(subscription.scheduledChange.effectiveAt)
      : null,
  });

  return true;
}

async function mirrorCustomerSubscriptions(
  customerId: string,
  businessId: string,
): Promise<number> {
  let mirrored = 0;

  for await (const subscription of paddleClient().subscriptions.list({
    customerId: [customerId],
  })) {
    if (await mirrorSubscription(subscription, businessId)) mirrored += 1;
  }

  return mirrored;
}

async function customerEmailMatches(
  customerId: string | null,
  email: string,
): Promise<boolean> {
  if (!customerId || !email) return false;
  try {
    const customer = await paddleClient().customers.get(customerId);
    return (
      customer.email.trim().toLowerCase() === email.trim().toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * Pull the current Paddle state for a tenant into our mirror.
 *
 * With a `transactionId` (the `_ptxn` query param Paddle appends to the
 * success URL) this is an exact, race-free lookup of what was just bought.
 * Without one it syncs whatever Paddle already knows about the tenant.
 */
export async function reconcileBusinessBilling(input: {
  businessId: string;
  userEmail: string;
  transactionId?: string | null;
}): Promise<ReconcileOutcome> {
  const paddle = paddleClient();

  if (input.transactionId) {
    let transaction;
    try {
      transaction = await paddle.transactions.get(input.transactionId);
    } catch (error) {
      if (error instanceof ApiError) {
        logger.warn(
          { code: error.code, transactionId: input.transactionId },
          "paddle: transaction lookup failed",
        );
        return { status: "not_found" };
      }
      throw error;
    }

    const tenantMatches =
      readBusinessId(transaction.customData) === input.businessId;
    const emailMatches = await customerEmailMatches(
      transaction.customerId,
      input.userEmail,
    );

    if (!tenantMatches && !emailMatches) {
      logger.warn(
        { transactionId: input.transactionId, businessId: input.businessId },
        "paddle: transaction does not belong to this tenant",
      );
      return { status: "not_found" };
    }

    if (transaction.customerId) {
      await linkCustomer(transaction.customerId, null, input.businessId);
    }

    if (transaction.subscriptionId) {
      const subscription = await paddle.subscriptions.get(
        transaction.subscriptionId,
      );
      const mirrored = await mirrorSubscription(
        subscription,
        input.businessId,
      );
      return mirrored
        ? { status: "ok", subscriptionsMirrored: 1 }
        : { status: "no_purchase" };
    }

    if (transaction.customerId) {
      const mirrored = await mirrorCustomerSubscriptions(
        transaction.customerId,
        input.businessId,
      );
      return mirrored > 0
        ? { status: "ok", subscriptionsMirrored: mirrored }
        : { status: "no_purchase" };
    }

    return { status: "no_purchase" };
  }

  // No transaction id: sync from the tenant's linked customer, or find one by
  // the signed-in user's email.
  const linked = await findBillingCustomerForBusiness(input.businessId);
  if (linked) {
    const mirrored = await mirrorCustomerSubscriptions(
      linked.customerId,
      input.businessId,
    );
    return mirrored > 0
      ? { status: "ok", subscriptionsMirrored: mirrored }
      : { status: "no_purchase" };
  }

  let mirrored = 0;
  for await (const customer of paddle.customers.list({
    email: [input.userEmail],
  })) {
    await linkCustomer(customer.id, customer.email, input.businessId);
    mirrored += await mirrorCustomerSubscriptions(
      customer.id,
      input.businessId,
    );
  }

  return mirrored > 0
    ? { status: "ok", subscriptionsMirrored: mirrored }
    : { status: "no_purchase" };
}
