import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runLeadAgent } from "../src/agents/lead-agent";
import type { AiProvider } from "../src/agents/provider";
import { createApp } from "../src/app";
import {
  PLAN_LIMITS,
  planForPriceId,
} from "../src/config/plans";
import { prisma } from "../src/lib/prisma";
import {
  assertUsage,
  checkAiRun,
  checkUsage,
  currentUsagePeriod,
  readUsage,
} from "../src/services/usage.service";
import { PLAN_PRICE, grantPlan } from "./helpers/plan";

/**
 * Usage limits (FEATURES §48, IMPLEMENTATION_PLAN step 31).
 *
 * The suite pins both halves of the contract:
 *   - metering is derived from real rows, in the current UTC month;
 *   - a plan allowance is enforced before the work happens (provider call or
 *     booking insert) and fails with a typed code a client can branch on.
 *
 * Every tenant is created fresh for this run, so counts never inherit rows
 * from another suite.
 */

const app = createApp();
const stamp = Date.now();
const password = "s3cure-pass-1";

interface Actor {
  email: string;
  cookie: string;
  userId: string;
}

function sessionCookieFrom(res: request.Response): string {
  const header = res.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  const session = cookies.find((cookie) => cookie.startsWith("authjs.session-token="));
  if (!session) throw new Error("expected an authjs.session-token cookie");
  return session.split(";")[0] ?? "";
}

async function registerActor(label: string): Promise<Actor> {
  const email = `usage-${label}-${stamp}@example.com`;
  const res = await request(app)
    .post("/api/v1/auth/register")
    .send({ name: `Usage ${label}`, email, password });
  if (res.status !== 201) {
    throw new Error(`register failed for ${label}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { email, cookie: sessionCookieFrom(res), userId: res.body.data.user.id as string };
}

async function createBusiness(actor: Actor, label: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", actor.cookie)
    .send({ name: `Usage ${label} ${stamp}`, type: "Plumber" });
  if (res.status !== 201) {
    throw new Error(`business create failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.business.id as string;
}

let owner: Actor;
let outsider: Actor;

let businessPro: string;
let businessStarter: string;
let businessNone: string;
let businessCancelled: string;
let businessTrial: string;
let businessUnknownPrice: string;
let businessAiConversations: string;
let businessAiMessages: string;
let businessAiNoPlan: string;

const businessLabels = [
  "Pro",
  "Starter",
  "None",
  "Cancelled",
  "Trial",
  "Unknown Price",
  "AI Conversations",
  "AI Messages",
  "AI No Plan",
];

/** A provider that never gets called in the refusal cases. */
function countingProvider(): { provider: AiProvider; calls: () => number } {
  let calls = 0;
  return {
    provider: {
      name: "usage-fake",
      async complete() {
        calls += 1;
        return {
          text: "Thanks — a member of the team will be in touch.",
          model: "usage-fake-model",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    },
    calls: () => calls,
  };
}

/** A conversation with a customer message, ready for the agent to answer. */
async function conversationFor(
  businessId: string,
  customerId: string,
): Promise<string> {
  const conversation = await prisma.conversation.create({
    data: { businessId, customerId, channel: "WEBSITE", status: "AI_ACTIVE" },
  });
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      sender: "CUSTOMER",
      content: "My boiler is leaking — can you help?",
    },
  });
  return conversation.id;
}

/** `count` distinct conversations, each with one AI message this month. */
async function seedAiConversations(
  businessId: string,
  customerId: string,
  count: number,
): Promise<void> {
  const conversations = await prisma.conversation.createManyAndReturn({
    data: Array.from({ length: count }, () => ({
      businessId,
      customerId,
      channel: "WEBSITE" as const,
      status: "AI_ACTIVE" as const,
    })),
    select: { id: true },
  });

  await prisma.message.createMany({
    data: conversations.map((conversation) => ({
      conversationId: conversation.id,
      sender: "AI" as const,
      content: "Automated reply.",
      aiGenerated: true,
    })),
  });
}

/** `count` AI messages inside one already-metered conversation. */
async function seedAiMessages(
  businessId: string,
  customerId: string,
  count: number,
): Promise<void> {
  const conversation = await prisma.conversation.create({
    data: { businessId, customerId, channel: "WEBSITE", status: "AI_ACTIVE" },
  });
  await prisma.message.createMany({
    data: Array.from({ length: count }, () => ({
      conversationId: conversation.id,
      sender: "AI" as const,
      content: "Automated reply.",
      aiGenerated: true,
    })),
  });
}

beforeAll(async () => {
  [owner, outsider] = await Promise.all([
    registerActor("owner"),
    registerActor("outsider"),
  ]);

  businessPro = await createBusiness(owner, "Pro");
  businessStarter = await createBusiness(owner, "Starter");
  businessNone = await createBusiness(owner, "None");
  businessCancelled = await createBusiness(owner, "Cancelled");
  businessTrial = await createBusiness(owner, "Trial");
  businessUnknownPrice = await createBusiness(owner, "Unknown Price");
  businessAiConversations = await createBusiness(owner, "AI Conversations");
  businessAiMessages = await createBusiness(owner, "AI Messages");
  businessAiNoPlan = await createBusiness(owner, "AI No Plan");

  await Promise.all([
    grantPlan(businessPro, "pro"),
    grantPlan(businessStarter, "starter"),
    grantPlan(businessCancelled, "pro", "canceled"),
    grantPlan(businessTrial, "pro", "trialing"),
    grantPlan(businessUnknownPrice, "pro"),
    grantPlan(businessAiConversations, "starter"),
    grantPlan(businessAiMessages, "starter"),
  ]);

  // An id this build does not know: the subscription is real, the plan is not.
  const unknown = await prisma.subscription.findUnique({
    where: { subscriptionId: `sub_test_${businessUnknownPrice}` },
  });
  await prisma.subscription.update({
    where: { subscriptionId: unknown!.subscriptionId },
    data: { priceId: "pri_usage_unknown_test" },
  });
}, 60000);

afterAll(async () => {
  await prisma.user.deleteMany({
    where: { id: { in: [owner.userId, outsider.userId] } },
  });
  await prisma.business.deleteMany({
    where: { name: { in: businessLabels.map((label) => `Usage ${label} ${stamp}`) } },
  });
});

/* ------------------------------------------------------------------ *
 * Pure rules
 * ------------------------------------------------------------------ */

describe("plan catalog", () => {
  it("maps both billing cycles of every tier to the same plan", () => {
    expect(planForPriceId(PLAN_PRICE.starter)).toBe("starter");
    expect(planForPriceId("pri_01m5ath3v9qb4paq34mq2gp611")).toBe("starter");
    expect(planForPriceId(PLAN_PRICE.pro)).toBe("pro");
    expect(planForPriceId("pri_01m5ath5hnqzdpx18rt01s74a4")).toBe("pro");
    expect(planForPriceId(PLAN_PRICE.advanced)).toBe("advanced");
    expect(planForPriceId("pri_01m5ath6f9wzaarxt41140a512")).toBe("advanced");
  });

  it("returns null for an unknown or missing price id", () => {
    expect(planForPriceId("pri_not_in_this_build")).toBeNull();
    expect(planForPriceId(null)).toBeNull();
  });

  it("states the limits the marketing page promises", () => {
    expect(PLAN_LIMITS.starter).toMatchObject({
      aiConversations: 100,
      aiMessages: 500,
      users: 1,
      bookings: 0,
    });
    expect(PLAN_LIMITS.pro).toMatchObject({
      aiConversations: 500,
      aiMessages: 2_500,
      users: 5,
      bookings: 500,
    });
    expect(PLAN_LIMITS.advanced).toMatchObject({
      aiConversations: 1_500,
      aiMessages: 7_500,
      users: 15,
      bookings: 1_500,
    });
  });
});

describe("usage period", () => {
  it("is the UTC calendar month", () => {
    const period = currentUsagePeriod(new Date("2026-01-15T23:30:00.000Z"));
    expect(period.start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("crosses the year boundary", () => {
    const period = currentUsagePeriod(new Date("2026-12-31T12:00:00.000Z"));
    expect(period.start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

/* ------------------------------------------------------------------ *
 * Metering + the usage endpoint
 * ------------------------------------------------------------------ */

describe("usage summary", () => {
  let customerId: string;

  beforeAll(async () => {
    const customer = await prisma.customer.create({
      data: { businessId: businessPro, name: "Usage Fixture" },
    });
    customerId = customer.id;

    const first = await prisma.conversation.create({
      data: { businessId: businessPro, customerId, channel: "WEBSITE" },
    });
    const second = await prisma.conversation.create({
      data: { businessId: businessPro, customerId, channel: "WEBSITE" },
    });

    await prisma.message.createMany({
      data: [
        { conversationId: first.id, sender: "AI", content: "One", aiGenerated: true },
        { conversationId: first.id, sender: "AI", content: "Two", aiGenerated: true },
        { conversationId: second.id, sender: "AI", content: "Three", aiGenerated: true },
        // A customer message must not count against the AI allowance.
        { conversationId: second.id, sender: "CUSTOMER", content: "Hello" },
      ],
    });

    await prisma.booking.create({
      data: {
        businessId: businessPro,
        customerId,
        startAt: new Date("2030-01-01T10:00:00.000Z"),
        endAt: new Date("2030-01-01T11:00:00.000Z"),
        status: "CONFIRMED",
      },
    });
  });

  it("requires authentication", async () => {
    const res = await request(app).get(`/api/v1/businesses/${businessPro}/usage`);
    expect(res.status).toBe(401);
  });

  it("answers 404 for a business the caller does not belong to", async () => {
    const res = await request(app)
      .get(`/api/v1/businesses/${businessPro}/usage`)
      .set("Cookie", outsider.cookie);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns the plan, period and all four metered quantities", async () => {
    const res = await request(app)
      .get(`/api/v1/businesses/${businessPro}/usage`)
      .set("Cookie", owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      plan: "pro",
      planName: "Pro",
      subscriptionActive: true,
      limitsEnforced: true,
    });

    const period = res.body.data.period as { start: string; end: string };
    expect(new Date(period.start).getUTCDate()).toBe(1);
    expect(new Date(period.end).getTime()).toBeGreaterThan(new Date(period.start).getTime());

    const metrics = res.body.data.metrics as Array<Record<string, unknown>>;
    const byKey = Object.fromEntries(metrics.map((metric) => [metric.key, metric]));

    expect(byKey.aiConversations).toMatchObject({ used: 2, limit: 500, reached: false });
    expect(byKey.aiMessages).toMatchObject({ used: 3, limit: 2_500, reached: false });
    expect(byKey.users).toMatchObject({ used: 1, limit: 5, reached: false });
    expect(byKey.bookings).toMatchObject({ used: 1, limit: 500, reached: false });
  });

  it("reports the plan as unenforced when the price id is unknown", async () => {
    const summary = await readUsage(businessUnknownPrice);
    expect(summary.subscriptionActive).toBe(true);
    expect(summary.plan).toBeNull();
    expect(summary.limitsEnforced).toBe(false);
    expect(summary.metrics.every((metric) => metric.limit === null)).toBe(true);

    // A verified payment must not be throttled by our mapping gap.
    const decision = await checkUsage(businessUnknownPrice, "bookings");
    expect(decision).toMatchObject({ allowed: true, limit: null });
  });

  it("treats a canceled subscription as inactive", async () => {
    const summary = await readUsage(businessCancelled);
    expect(summary.subscriptionActive).toBe(false);
    expect(summary.limitsEnforced).toBe(false);

    const decision = await checkUsage(businessCancelled, "bookings");
    expect(decision).toEqual({ allowed: false, reason: "subscription_required" });
  });

  it("counts a trialing subscription as active", async () => {
    const decision = await checkUsage(businessTrial, "bookings");
    expect(decision.allowed).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Booking enforcement
 * ------------------------------------------------------------------ */

describe("booking limits", () => {
  let customerForStarter: string;
  let customerForNone: string;

  beforeAll(async () => {
    const [starter, none] = await Promise.all([
      prisma.customer.create({
        data: { businessId: businessStarter, name: "Starter Customer" },
      }),
      prisma.customer.create({
        data: { businessId: businessNone, name: "Unsubscribed Customer" },
      }),
    ]);
    customerForStarter = starter.id;
    customerForNone = none.id;
  });

  it("refuses a booking with no active subscription (403 SUBSCRIPTION_REQUIRED)", async () => {
    const res = await request(app)
      .post("/api/v1/bookings")
      .set("Cookie", owner.cookie)
      .send({
        businessId: businessNone,
        customerId: customerForNone,
        startAt: new Date(Date.now() + 86_400_000).toISOString(),
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("SUBSCRIPTION_REQUIRED");
  });

  it("refuses a booking the plan does not include (409 USAGE_LIMIT_REACHED)", async () => {
    const res = await request(app)
      .post("/api/v1/bookings")
      .set("Cookie", owner.cookie)
      .send({
        businessId: businessStarter,
        customerId: customerForStarter,
        startAt: new Date(Date.now() + 86_400_000).toISOString(),
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("USAGE_LIMIT_REACHED");
    expect(res.body.error.message).toContain("isn't included");
  });

  it("checks the allowance after tenant ownership (a foreign customer still 404s)", async () => {
    const res = await request(app)
      .post("/api/v1/bookings")
      .set("Cookie", owner.cookie)
      .send({
        businessId: businessStarter,
        customerId: customerForNone,
        startAt: new Date(Date.now() + 86_400_000).toISOString(),
      });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("throws the same typed code from the direct pre-flight helper", async () => {
    await expect(assertUsage(businessStarter, "bookings")).rejects.toMatchObject({
      statusCode: 409,
      code: "USAGE_LIMIT_REACHED",
    });
    await expect(assertUsage(businessNone, "bookings")).rejects.toMatchObject({
      statusCode: 403,
      code: "SUBSCRIPTION_REQUIRED",
    });
  });
});

/* ------------------------------------------------------------------ *
 * AI pipeline enforcement
 * ------------------------------------------------------------------ */

describe("AI limits", () => {
  let customerConversations: string;
  let customerMessages: string;
  let customerNoPlan: string;

  beforeAll(async () => {
    const [conversations, messages, noPlan] = await Promise.all([
      prisma.customer.create({
        data: { businessId: businessAiConversations, name: "AI Conversations Customer" },
      }),
      prisma.customer.create({
        data: { businessId: businessAiMessages, name: "AI Messages Customer" },
      }),
      prisma.customer.create({
        data: { businessId: businessAiNoPlan, name: "No Plan Customer" },
      }),
    ]);
    customerConversations = conversations.id;
    customerMessages = messages.id;
    customerNoPlan = noPlan.id;

    // Starter: 100 conversations and 500 messages.
    await seedAiConversations(businessAiConversations, customerConversations, 100);
    await seedAiMessages(businessAiMessages, customerMessages, 500);
  }, 60000);

  it("stops the run at the conversation cap before calling the provider", async () => {
    const conversationId = await conversationFor(businessAiConversations, customerConversations);
    const { provider, calls } = countingProvider();

    const result = await runLeadAgent(conversationId, { provider });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("limit_reached");
    expect(result.usageLimit).toMatchObject({ metric: "aiConversations", limit: 100 });
    expect(calls()).toBe(0);
  });

  it("stops the run at the message cap even inside an already-counted thread", async () => {
    const conversationId = await conversationFor(businessAiMessages, customerMessages);
    const { provider, calls } = countingProvider();

    const result = await runLeadAgent(conversationId, { provider });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("limit_reached");
    expect(result.usageLimit).toMatchObject({ metric: "aiMessages", limit: 500 });
    expect(calls()).toBe(0);
  });

  it("stops the run when the business has no active plan", async () => {
    const conversationId = await conversationFor(businessAiNoPlan, customerNoPlan);
    const { provider, calls } = countingProvider();

    const result = await runLeadAgent(conversationId, { provider });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("subscription_required");
    expect(calls()).toBe(0);
  });

  it("allows a follow-up in a thread that is already counted this month", async () => {
    // businessAiConversations is at 100/100, but this thread is one of them and
    // already has an AI message; the message cap is untouched.
    const existing = await prisma.message.findFirst({
      where: { conversation: { businessId: businessAiConversations }, aiGenerated: true },
      select: { conversationId: true },
    });
    expect(existing).not.toBeNull();

    const customer = await prisma.message.create({
      data: {
        conversationId: existing!.conversationId,
        sender: "CUSTOMER",
        content: "One more question, please.",
      },
    });
    expect(customer.id).toBeTruthy();

    const check = await checkAiRun(businessAiConversations, existing!.conversationId);
    expect(check.allowed).toBe(true);
  });
});
