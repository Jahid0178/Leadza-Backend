import type { Request, Response } from "express";
import type { SessionUser } from "../auth/types";
import { paddleWebhookSecret, paddleClient } from "../config/paddle";
import { findBillingCustomerForBusiness } from "../repositories/billing.repository";
import {
  createCustomerPortalSession,
  findAccessGrantingSubscription,
} from "../services/paddle-billing";
import { reconcileBusinessBilling } from "../services/paddle-sync";
import { routePaddleEvent } from "../services/paddle-webhooks";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";
import { parseAfterAuth, requireMembership } from "../utils/business-access";
import { logger } from "../utils/logger";
import {
  paddlePortalSchema,
  paddleReconcileSchema,
  paddleStatusQuerySchema,
} from "../validation/paddle.schemas";

/**
 * Paddle controller (IMPLEMENTATION_PLAN Phase H).
 */

/**
 * POST /api/v1/paddle/webhook — verified Paddle notification receiver.
 *
 * Mounted with `express.raw()` **before** the JSON body parser, so it sees the
 * exact bytes Paddle signed. A parsed body would fail verification.
 *
 * Status codes are deliberate:
 *   - 200 → delivery accepted (Paddle stops retrying).
 *   - 401 → signature missing/invalid (never a 2xx, so Paddle retries and the
 *     bad delivery is visible).
 *   - 500 → verified but our handler failed (Paddle retries).
 */
export async function paddleWebhook(req: Request, res: Response) {
  const signature = req.get("Paddle-Signature");
  const rawBody = req.body;

  if (!signature || !Buffer.isBuffer(rawBody)) {
    res.status(400).json({ error: "Missing signature or raw body." });
    return;
  }

  // A missing secret is a configuration error → let it reach the error
  // middleware as a 500 rather than disguising it as a bad signature.
  const secret = paddleWebhookSecret();
  const paddle = paddleClient();

  // Signature first, on its own, so a bad signature (401) is never confused
  // with a payload we failed to parse (500, retry).
  let signatureValid: boolean;
  try {
    signatureValid = await paddle.webhooks.isSignatureValid(
      rawBody.toString("utf8"),
      secret,
      signature,
    );
  } catch (error) {
    logger.warn({ err: error }, "paddle: malformed Paddle-Signature header");
    res.status(401).json({ error: "Invalid signature." });
    return;
  }

  if (!signatureValid) {
    logger.warn("paddle: webhook signature verification failed");
    res.status(401).json({ error: "Invalid signature." });
    return;
  }

  let event;
  try {
    event = await paddle.webhooks.unmarshal(
      rawBody.toString("utf8"),
      secret,
      signature,
    );
  } catch (error) {
    // Genuinely signed but not parseable → our problem, not the sender's.
    // Non-2xx so Paddle retries and the failure is visible.
    logger.error({ err: error }, "paddle: signed webhook could not be parsed");
    res.status(500).json({ error: "Webhook could not be parsed." });
    return;
  }

  try {
    await routePaddleEvent(event);
  } catch (error) {
    // Verified but unprocessable. Return non-2xx so Paddle retries.
    logger.error(
      { err: error, eventType: event.eventType },
      "paddle: webhook handler failed",
    );
    res.status(500).json({ error: "Webhook handler failed." });
    return;
  }

  res.status(200).json({ received: true });
}

function requireUser(req: Request): SessionUser {
  const user = req.user;
  if (!user) {
    throw ApiError.unauthorized("UNAUTHENTICATED", "You need to sign in to continue.");
  }
  return user;
}

/**
 * POST /api/v1/paddle/portal — mint a hosted customer-portal session.
 *
 * The tenant comes from the request and is verified with `requireMembership`
 * before anything is minted; the Paddle customer id is resolved server-side
 * from our own tables, never trusted from the client.
 */
export async function createPortalSession(req: Request, res: Response) {
  const user = requireUser(req);
  const input = parseAfterAuth(paddlePortalSchema, req.body);

  await requireMembership(user.id, input.businessId);

  const url = await createCustomerPortalSession(input.businessId);
  if (!url) {
    throw ApiError.notFound(
      "NO_BILLING_ACCOUNT",
      "No billing account is linked to this business yet.",
    );
  }

  res.json(apiSuccess({ url }));
}

/**
 * POST /api/v1/paddle/reconcile — mirror the current Paddle state.
 *
 * This is the fallback when a webhook cannot be delivered (for example while
 * the notification destination points at localhost). It reads from the Paddle
 * API with our server key and writes through the same idempotent upserts, so
 * it is safe to call on every visit to the billing or success page.
 */
export async function reconcileBilling(req: Request, res: Response) {
  const user = requireUser(req);
  const input = parseAfterAuth(paddleReconcileSchema, req.body);

  await requireMembership(user.id, input.businessId);

  const outcome = await reconcileBusinessBilling({
    businessId: input.businessId,
    userEmail: user.email,
    transactionId: input.transactionId ?? null,
  });

  // A transaction that names another tenant must look like it does not exist
  // (§13: never confirm another tenant's resource).
  if (outcome.status === "not_found") {
    throw ApiError.notFound(
      "NOT_FOUND",
      "The requested resource was not found.",
    );
  }

  const [granting, customer] = await Promise.all([
    findAccessGrantingSubscription(input.businessId),
    findBillingCustomerForBusiness(input.businessId),
  ]);

  res.json(
    apiSuccess({
      hasAccess: granting !== null,
      linkedToPaddle: customer !== null,
      status: granting?.status ?? null,
      priceId: granting?.priceId ?? null,
      reconciled: outcome.status === "ok",
    }),
  );
}

/** GET /api/v1/paddle/status?businessId=… — mirrored billing state. */
export async function getBillingStatus(req: Request, res: Response) {
  const user = requireUser(req);
  const query = parseAfterAuth(paddleStatusQuerySchema, req.query);

  await requireMembership(user.id, query.businessId);

  const [granting, customer] = await Promise.all([
    findAccessGrantingSubscription(query.businessId),
    findBillingCustomerForBusiness(query.businessId),
  ]);

  res.json(
    apiSuccess({
      hasAccess: granting !== null,
      // A linked Paddle customer means the portal can be opened.
      linkedToPaddle: customer !== null,
      status: granting?.status ?? null,
      priceId: granting?.priceId ?? null,
    }),
  );
}
