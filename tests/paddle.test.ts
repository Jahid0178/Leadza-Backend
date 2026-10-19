import crypto from "node:crypto";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { prisma } from "../src/lib/prisma";
import {
  businessHasPaidAccess,
  subscriptionStatusGrantsAccess,
} from "../src/services/paddle-billing";

/**
 * Paddle billing (IMPLEMENTATION_PLAN Phase H).
 *
 * The webhook is exercised end to end against the real Express app: a real
 * HMAC signature is computed the way Paddle does (`sha256(ts + ":" + body)`
 * with the notification destination's secret), so the tests prove the handler
 * verifies, rejects and fulfils deliveries for real.
 *
 * Fixtures use fixed Paddle-style ids and are written through upserts, so
 * repeated runs converge instead of accumulating rows. Nothing is deleted.
 */

const app = createApp();

const secret = env.PADDLE_WEBHOOK_SANDBOX_SECRET ?? "";
const hasSecret = secret.length > 0;

const BUSINESS_ID = "biz_leadza_paddle_test";
const CUSTOMER_ID = "ctm_leadza_paddle_test";
const SUBSCRIPTION_ID = "sub_leadza_paddle_test";
const PRICE_ID = "pri_leadza_paddle_test_month";
const PRODUCT_ID = "pro_leadza_paddle_test";
const CUSTOMER_EMAIL = "paddle-buyer@leadza.test";
const NOW = "2026-01-01T00:00:00.000Z";

/** Paddle's signature: `ts=<unix seconds>;h1=<hex hmac of "ts:body">`. */
function sign(body: string, key: string = secret): string {
  const ts = Math.floor(Date.now() / 1000);
  const h1 = crypto
    .createHmac("sha256", key)
    .update(`${ts}:${body}`)
    .digest("hex");
  return `ts=${ts};h1=${h1}`;
}

function eventBody(eventType: string, data: unknown): string {
  return JSON.stringify({
    event_id: `evt_leadza_paddle_test_${eventType}`,
    notification_id: `ntf_leadza_paddle_test_${eventType}`,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    data,
  });
}

async function deliver(
  eventType: string,
  data: unknown,
  signature?: string,
): Promise<request.Response> {
  const body = eventBody(eventType, data);
  return request(app)
    .post("/api/v1/paddle/webhook")
    .set("Content-Type", "application/json")
    .set("Paddle-Signature", signature ?? sign(body))
    .send(body);
}

/** A realistic `customer` notification payload. */
function customerData() {
  return {
    id: CUSTOMER_ID,
    name: "Paddle Test Buyer",
    email: CUSTOMER_EMAIL,
    marketing_consent: false,
    status: "active",
    custom_data: { businessId: BUSINESS_ID },
    locale: "en",
    created_at: NOW,
    updated_at: NOW,
    import_meta: null,
  };
}

/** A realistic `subscription` notification payload. */
function subscriptionData(status: string, scheduledChange: unknown = null) {
  return {
    id: SUBSCRIPTION_ID,
    status,
    transaction_id: "txn_leadza_paddle_test",
    customer_id: CUSTOMER_ID,
    address_id: "add_leadza_paddle_test",
    business_id: null,
    currency_code: "USD",
    created_at: NOW,
    updated_at: NOW,
    started_at: null,
    first_billed_at: null,
    next_billed_at: null,
    paused_at: null,
    canceled_at: status === "canceled" ? NOW : null,
    discount: null,
    collection_mode: "automatic",
    billing_details: null,
    current_billing_period: null,
    billing_cycle: { interval: "month", frequency: 1 },
    scheduled_change: scheduledChange,
    items: [
      {
        status: "active",
        quantity: 1,
        recurring: true,
        created_at: NOW,
        updated_at: NOW,
        previously_billed_at: null,
        next_billed_at: null,
        trial_dates: null,
        price: {
          id: PRICE_ID,
          product_id: PRODUCT_ID,
          description: "Test monthly",
          type: "standard",
          name: null,
          billing_cycle: { interval: "month", frequency: 1 },
          trial_period: { interval: "day", frequency: 7 },
          tax_mode: "account_setting",
          unit_price: { amount: "1000", currency_code: "USD" },
          unit_price_overrides: [],
          quantity: null,
          status: "active",
          custom_data: null,
          import_meta: null,
        },
        product: {
          id: PRODUCT_ID,
          name: "Paddle Test Plan",
          type: "standard",
          description: null,
          tax_category: "standard",
          image_url: null,
          custom_data: null,
          status: "active",
          created_at: NOW,
          updated_at: null,
          import_meta: null,
        },
      },
    ],
    custom_data: { businessId: BUSINESS_ID },
    import_meta: null,
  };
}

beforeAll(async () => {
  // A real business row so `custom_data.businessId` resolves (§13).
  await prisma.business.upsert({
    where: { id: BUSINESS_ID },
    create: { id: BUSINESS_ID, name: "Paddle Test Business" },
    update: {},
  });
});

describe("paddle webhook — request shape", () => {
  it("rejects a delivery with no signature", async () => {
    const res = await request(app)
      .post("/api/v1/paddle/webhook")
      .set("Content-Type", "application/json")
      .send(eventBody("customer.created", customerData()));

    expect(res.status).toBe(400);
  });
});

describe.runIf(hasSecret)("paddle webhook — signature verification", () => {
  it("rejects a signature made with the wrong secret (401, never 2xx)", async () => {
    const body = eventBody("customer.created", customerData());
    const res = await deliver(
      "customer.created",
      customerData(),
      sign(body, "pdl_ntfset_wrong_secret"),
    );

    expect(res.status).toBe(401);
  });

  it("rejects a tampered body signed under a different payload", async () => {
    const signed = sign(eventBody("customer.created", customerData()));
    const res = await request(app)
      .post("/api/v1/paddle/webhook")
      .set("Content-Type", "application/json")
      .set("Paddle-Signature", signed)
      .send(eventBody("customer.updated", { ...customerData(), email: "tampered@evil.test" }));

    expect(res.status).toBe(401);
  });

  it("answers 500 (not 401) for a correctly signed but unparseable payload", async () => {
    // Signed with the real secret but missing the fields the SDK needs, so
    // this is our failure to process — and must be retried, not rejected.
    const res = await deliver("subscription.created", { id: "sub_incomplete" });
    expect(res.status).toBe(500);
  });
});

describe.runIf(hasSecret)("paddle webhook — fulfilment", () => {
  it("mirrors customer.created into billing_customers and links the tenant", async () => {
    const res = await deliver("customer.created", customerData());
    expect(res.status).toBe(200);

    const customer = await prisma.paddleCustomer.findUnique({
      where: { customerId: CUSTOMER_ID },
    });
    expect(customer).not.toBeNull();
    expect(customer?.email).toBe(CUSTOMER_EMAIL);
    expect(customer?.businessId).toBe(BUSINESS_ID);
  });

  it("is idempotent across replays (one row per Paddle id)", async () => {
    await deliver("customer.created", customerData());
    await deliver("customer.updated", {
      ...customerData(),
      email: "paddle-buyer+updated@leadza.test",
    });

    const rows = await prisma.paddleCustomer.findMany({
      where: { customerId: CUSTOMER_ID },
    });
    expect(rows).toHaveLength(1);
    // The later event wins on the mutable fields.
    expect(rows[0]?.email).toBe("paddle-buyer+updated@leadza.test");
  });

  it("mirrors subscription status and drives the access helper", async () => {
    // Trial grants access (§ brief: active and trialing grant).
    await deliver("subscription.created", subscriptionData("trialing"));
    let mirrored = await prisma.subscription.findUnique({
      where: { subscriptionId: SUBSCRIPTION_ID },
    });
    expect(mirrored?.status).toBe("trialing");
    expect(mirrored?.businessId).toBe(BUSINESS_ID);
    expect(mirrored?.priceId).toBe(PRICE_ID);
    expect(mirrored?.productId).toBe(PRODUCT_ID);
    expect(await businessHasPaidAccess(BUSINESS_ID)).toBe(true);

    // past_due denies.
    await deliver("subscription.updated", subscriptionData("past_due"));
    expect(await businessHasPaidAccess(BUSINESS_ID)).toBe(false);

    // paused denies.
    await deliver("subscription.updated", subscriptionData("paused"));
    expect(await businessHasPaidAccess(BUSINESS_ID)).toBe(false);

    // active grants again.
    await deliver("subscription.updated", subscriptionData("active"));
    expect(await businessHasPaidAccess(BUSINESS_ID)).toBe(true);
  });

  it("does NOT revoke access for a scheduled change alone", async () => {
    const scheduledChange = {
      action: "cancel",
      effective_at: "2026-02-01T00:00:00.000Z",
      resume_at: null,
    };

    await deliver(
      "subscription.updated",
      subscriptionData("active", scheduledChange),
    );

    const mirrored = await prisma.subscription.findUnique({
      where: { subscriptionId: SUBSCRIPTION_ID },
    });
    // The scheduled change is recorded…
    expect(mirrored?.scheduledChangeAction).toBe("cancel");
    expect(mirrored?.scheduledChangeAt?.toISOString()).toBe(
      "2026-02-01T00:00:00.000Z",
    );
    // …but access is still granted, because the status is still active.
    expect(await businessHasPaidAccess(BUSINESS_ID)).toBe(true);
  });

  it("revokes access once the subscription is canceled", async () => {
    await deliver("subscription.canceled", subscriptionData("canceled"));

    const mirrored = await prisma.subscription.findUnique({
      where: { subscriptionId: SUBSCRIPTION_ID },
    });
    expect(mirrored?.status).toBe("canceled");
    expect(await businessHasPaidAccess(BUSINESS_ID)).toBe(false);
  });

  it("accepts transaction.completed without failing", async () => {
    const res = await deliver("transaction.completed", {
      id: "txn_leadza_paddle_test",
      status: "completed",
      customer_id: CUSTOMER_ID,
      subscription_id: SUBSCRIPTION_ID,
      currency_code: "USD",
      created_at: NOW,
      updated_at: NOW,
      items: [],
      details: {
        tax_rates_used: [],
        totals: {
          subtotal: "1000",
          discount: "0",
          tax: "0",
          total: "1000",
          credit: "0",
          balance: "1000",
          grand_total: "1000",
          fee: "0",
          earnings: "1000",
          currency_code: "USD",
        },
        line_items: [],
      },
      payments: [],
      custom_data: { businessId: BUSINESS_ID },
      import_meta: null,
    });

    expect(res.status).toBe(200);
  });

  it("ignores event types it does not handle, with a 2xx", async () => {
    const res = await deliver("subscription.imported", subscriptionData("active"));
    expect(res.status).toBe(200);
  });
});

describe("subscription access rule", () => {
  it.each([
    ["active", true],
    ["trialing", true],
    ["paused", false],
    ["past_due", false],
    ["canceled", false],
  ])("%s → %s", (status, expected) => {
    expect(subscriptionStatusGrantsAccess(status)).toBe(expected);
  });
});

describe("paddle portal route", () => {
  it("requires authentication", async () => {
    const res = await request(app)
      .post("/api/v1/paddle/portal")
      .send({ businessId: BUSINESS_ID });

    expect(res.status).toBe(401);
  });

  it("never trusts an unauthenticated business id", async () => {
    const res = await request(app)
      .get(`/api/v1/paddle/status?businessId=${BUSINESS_ID}`);

    expect(res.status).toBe(401);
  });
});

describe("paddle reconcile route", () => {
  it("requires authentication", async () => {
    const res = await request(app)
      .post("/api/v1/paddle/reconcile")
      .send({ businessId: BUSINESS_ID });

    expect(res.status).toBe(401);
  });

  it("refuses a business the caller doesn't belong to", async () => {
    const email = `paddle-outsider-${Date.now()}@example.com`;
    const registered = await request(app)
      .post("/api/v1/auth/register")
      .send({ name: "Paddle Outsider", email, password: "s3cure-pass-1" });

    expect(registered.status).toBe(201);

    const cookies = registered.headers["set-cookie"];
    const cookie = (Array.isArray(cookies) ? cookies : [cookies ?? ""])
      .find((value) => value.startsWith("authjs.session-token="))
      ?.split(";")[0];

    // The membership check must reject before any Paddle lookup happens, so the
    // transaction id here is deliberately garbage.
    const res = await request(app)
      .post("/api/v1/paddle/reconcile")
      .set("Cookie", cookie ?? "")
      .send({ businessId: BUSINESS_ID, transactionId: "txn_not_yours" });

    expect(res.status).toBe(404);
  });
});
