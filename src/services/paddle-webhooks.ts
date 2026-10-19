import type { EventEntity } from "@paddle/paddle-node-sdk";
import {
  businessExists,
  findBillingCustomer,
  findBusinessIdForEmail,
  upsertBillingCustomer,
  upsertSubscription,
} from "../repositories/billing.repository";
import { logger } from "../utils/logger";

/**
 * Paddle webhook routing (IMPLEMENTATION_PLAN Phase H).
 *
 * Only verified events reach here. Handlers are idempotent: every write is an
 * upsert keyed on the Paddle id, so a replay or an out-of-order delivery is
 * safe. Unrecognised event types are ignored by design.
 */

/* ----------------------------- narrowing helpers ----------------------------- */

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** Pull the price/product ids off a subscription's first recurring item. */
function firstItemIds(data: Record<string, unknown>): {
  priceId: string | null;
  productId: string | null;
} {
  const items = Array.isArray(data.items) ? data.items : [];
  for (const raw of items) {
    const item = asRecord(raw);
    const price = asRecord(item?.price);
    const product = asRecord(item?.product);
    const priceId = asString(price?.id);
    if (priceId) return { priceId, productId: asString(product?.id) };
  }
  return { priceId: null, productId: null };
}

/**
 * Resolve the tenant a billing record belongs to, without trusting the
 * client: a `customData.businessId` is only used if it names a real business,
 * otherwise the owner's email is matched to a platform user.
 */
async function resolveBusinessId(
  customData: Record<string, unknown> | null,
  email: string | null,
): Promise<string | null> {
  const fromCustom = asString(customData?.businessId);
  if (fromCustom && (await businessExists(fromCustom))) return fromCustom;
  if (email) return findBusinessIdForEmail(email);
  return null;
}

/* --------------------------------- handlers --------------------------------- */

async function handleCustomerUpserted(data: Record<string, unknown>) {
  const customerId = asString(data.id);
  const email = asString(data.email);
  if (!customerId || !email) {
    logger.warn({ customerId, hasEmail: Boolean(email) }, "paddle: customer event missing id/email");
    return;
  }

  const businessId = await resolveBusinessId(asRecord(data.customData), email);

  await upsertBillingCustomer({ customerId, email, businessId });
  logger.info({ customerId, businessId }, "paddle: customer mirrored");
}

async function handleSubscriptionChanged(data: Record<string, unknown>) {
  const subscriptionId = asString(data.id);
  const customerId = asString(data.customerId);
  const status = asString(data.status);
  if (!subscriptionId || !customerId || !status) {
    logger.warn(
      { subscriptionId, customerId, status },
      "paddle: subscription event missing required fields",
    );
    return;
  }

  const { priceId, productId } = firstItemIds(data);
  if (!priceId || !productId) {
    logger.warn({ subscriptionId }, "paddle: subscription event has no priced item");
    return;
  }

  const scheduledChange = asRecord(data.scheduledChange);
  const scheduledChangeAction = asString(scheduledChange?.action);
  const effectiveAt = asString(scheduledChange?.effectiveAt);
  const createdAt = asString(data.createdAt);
  const nextBilledAt = asString(data.nextBilledAt);

  // Prefer the tenant already linked to this customer; fall back to custom
  // data (validated) so a first-time subscription can establish the link.
  const existing = await findBillingCustomer(customerId);
  const businessId =
    existing?.businessId ?? (await resolveBusinessId(asRecord(data.customData), null));

  await upsertSubscription({
    subscriptionId,
    customerId,
    businessId,
    status,
    priceId,
    productId,
    scheduledChangeAction,
    scheduledChangeAt: effectiveAt ? new Date(effectiveAt) : null,
    paddleCreatedAt: createdAt ? new Date(createdAt) : null,
    nextBilledAt: nextBilledAt ? new Date(nextBilledAt) : null,
  });

  // Backfill the customer link when the subscription established it.
  if (businessId && !existing?.businessId && existing?.email) {
    await upsertBillingCustomer({
      customerId,
      email: existing.email,
      businessId,
    });
  }

  logger.info(
    { subscriptionId, status, businessId, scheduledChangeAction },
    "paddle: subscription mirrored",
  );
}

async function handleTransactionCompleted(data: Record<string, unknown>) {
  const transactionId = asString(data.id);
  const subscriptionId = asString(data.subscriptionId);
  const customerId = asString(data.customerId);
  // A completed transaction needs no state of its own; subscription and
  // customer events carry the entitlement. Log for traceability.
  logger.info(
    { transactionId, subscriptionId, customerId },
    "paddle: transaction completed",
  );
}

/* --------------------------------- routing ---------------------------------- */

/** Route one verified event to its handler. Unknown types are ignored. */
export async function routePaddleEvent(event: EventEntity): Promise<void> {
  const data = asRecord(event.data);
  if (!data) {
    logger.warn({ eventType: event.eventType }, "paddle: event has no data payload");
    return;
  }

  switch (event.eventType) {
    case "customer.created":
    case "customer.updated":
      await handleCustomerUpserted(data);
      return;

    case "subscription.created":
    case "subscription.updated":
    case "subscription.canceled":
      await handleSubscriptionChanged(data);
      return;

    case "transaction.completed":
      await handleTransactionCompleted(data);
      return;

    default:
      logger.debug({ eventType: event.eventType }, "paddle: ignored event type");
  }
}
