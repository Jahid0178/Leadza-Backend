import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runLeadAgent } from "../src/agents/lead-agent";
import { createDisabledProvider, type AiProvider } from "../src/agents/provider";
import {
  addUsageTotals,
  estimateCostUsd,
} from "../src/agents/usage";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { grantPlan } from "./helpers/plan";

/**
 * AI usage tracking (FEATURES §49, IMPLEMENTATION_PLAN step 32).
 *
 * Three contracts:
 *   - the agent records one `ai_usage` row per run, on every exit path that
 *     touched the provider (tool rounds summed), and never lets a recording
 *     failure break a reply;
 *   - cost is the provider's reported charge when it returns one, otherwise
 *     the price table, else 0 — never invented;
 *   - /admin/usage and the business detail read those rows back for the
 *     current UTC month only, cross-tenant behind the platform admin gate.
 */

const app = createApp();
const stamp = Date.now();
const password = "s3cure-pass-1";

/** A provider faking both usage and model, so cost rules are observable. */
function fakeProvider(
  name: string,
  turns: Array<{
    text?: string;
    model?: string;
    usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
  }>,
): { provider: AiProvider; calls: () => number } {
  let calls = 0;
  return {
    provider: {
      name,
      async complete() {
        const turn = turns[Math.min(calls, turns.length - 1)];
        calls += 1;
        return {
          text: turn?.text ?? "",
          model: turn?.model ?? "record-test-model",
          usage: turn?.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          ...(turn?.toolCalls ? { toolCalls: turn?.toolCalls } : {}),
        };
      },
    },
    calls: () => calls,
  };
}

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
  const email = `ai-usage-${label}-${stamp}@example.com`;
  const res = await request(app)
    .post("/api/v1/auth/register")
    .send({ name: `AI Usage ${label}`, email, password });
  if (res.status !== 201) {
    throw new Error(`register failed for ${label}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { email, cookie: sessionCookieFrom(res), userId: res.body.data.user.id as string };
}

async function createBusiness(actor: Actor, label: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", actor.cookie)
    .send({ name: `AI Usage ${label} ${stamp}`, type: "Plumber" });
  if (res.status !== 201) {
    throw new Error(`business create failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.business.id as string;
}

/** A conversation with one customer message, ready for the agent. */
async function conversationFor(businessId: string): Promise<{
  conversationId: string;
  customerId: string;
}> {
  const customer = await prisma.customer.create({
    data: { businessId, name: `AI Usage Customer ${stamp}` },
  });
  const conversation = await prisma.conversation.create({
    data: { businessId, customerId: customer.id, channel: "WEBSITE", status: "AI_ACTIVE" },
  });
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      sender: "CUSTOMER",
      content: "My boiler is leaking — can you help?",
    },
  });
  return { conversationId: conversation.id, customerId: customer.id };
}

/** Directly seed one `ai_usage` row (provenance fixtures for the reads). */
function seedUsage(input: {
  businessId: string;
  conversationId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  createdAt?: Date;
}) {
  return prisma.aiUsage.create({
    data: {
      businessId: input.businessId,
      conversationId: input.conversationId,
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      estimatedCost: input.estimatedCost,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
    select: { id: true },
  });
}

/** Rows written by the agent for one conversation. */
function usageRows(conversationId: string) {
  return prisma.aiUsage.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } });
}

let owner: Actor;
let outsider: Actor;
let admin: Actor;

let businessPro: string;
let businessFree: string;
let businessReport: string;

beforeAll(async () => {
  [owner, outsider] = await Promise.all([registerActor("owner"), registerActor("outsider")]);

  businessPro = await createBusiness(owner, "Pro");
  businessFree = await createBusiness(outsider, "Free");
  businessReport = await createBusiness(owner, "Report");

  // Agent runs need an active plan; the report business is admin-read only.
  await grantPlan(businessPro, "pro");

  // Promote with a re-login so the fixture cookie is honest (step 28 pattern).
  await prisma.user.update({
    where: { id: owner.userId },
    data: { platformRole: "PLATFORM_ADMIN" },
  });
  admin = { ...owner, cookie: await (async () => {
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: owner.email, password });
    return sessionCookieFrom(login);
  })() };
}, 60000);

afterAll(async () => {
  // Billing mirror rows live outside the business cascade — delete explicitly.
  await prisma.subscription.deleteMany({ where: { subscriptionId: `sub_test_${businessPro}` } });
  await prisma.paddleCustomer.deleteMany({ where: { customerId: `ctm_test_${businessPro}` } });
  // ai_usage rows cascade with their business.
  await prisma.business.deleteMany({ where: { id: { in: [businessPro, businessFree, businessReport] } } });
  await prisma.user.deleteMany({ where: { id: { in: [owner.userId, outsider.userId] } } });
});

describe("cost estimation (§49)", () => {
  it("uses the provider's reported cost when the response carries one", () => {
    const cost = estimateCostUsd("anything/else", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
      reportedCostUsd: 0.12345649,
    });
    expect(cost).toBe(0.123456);
  });

  it("falls back to the verified price table for token-only providers", () => {
    // gpt-4o-mini: $0.15 in / $0.60 out per 1M → 10K of each = 0.0075.
    expect(estimateCostUsd("gpt-4o-mini", { inputTokens: 10_000, outputTokens: 10_000, totalTokens: 20_000 })).toBe(
      0.0075,
    );
  });

  it("resolves vendor-prefixed and versioned model ids", () => {
    expect(
      estimateCostUsd("openai/gpt-4o-mini-2024-07-18", {
        inputTokens: 10_000,
        outputTokens: 10_000,
        totalTokens: 20_000,
      }),
    ).toBe(0.0075);
  });

  it("prices an unknown model at zero rather than a guess", () => {
    expect(estimateCostUsd("unknown-model", { inputTokens: 99, outputTokens: 99, totalTokens: 198 })).toBe(0);
  });

  it("sums totals turn by turn without dropping reasoning tokens", () => {
    const total = addUsageTotals({ inputTokens: 5, outputTokens: 5, totalTokens: 30 }, {
      inputTokens: 8,
      outputTokens: 12,
      totalTokens: 20,
    });
    expect(total).toEqual({ inputTokens: 13, outputTokens: 17, totalTokens: 50 });
  });
});

describe("agent usage recording (§49)", () => {
  it("records one row per run with provenance and summed tokens", async () => {
    const { conversationId } = await conversationFor(businessPro);
    const { provider } = fakeProvider("record-fake", [
      {
        text: "Thanks — which postcode is the boiler at?",
        model: "record-test-model",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      },
    ]);

    const result = await runLeadAgent(conversationId, { provider });
    expect(result.status).toBe("replied");
    expect(result.usage?.totalTokens).toBe(30);

    const rows = await usageRows(conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      businessId: businessPro,
      conversationId,
      provider: "record-fake",
      model: "record-test-model",
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      // "record-test-model" is not in the price table and reports no cost.
      estimatedCost: 0,
    });
  });

  it("sums tokens across tool rounds into the run's single row", async () => {
    const { conversationId } = await conversationFor(businessPro);
    const { provider, calls } = fakeProvider("record-tools", [
      {
        model: "record-test-model",
        usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
        toolCalls: [
          { id: "c1", name: "updateLead", arguments: { urgency: "HIGH" } },
        ],
      },
      {
        text: "Noted — we'll get a plumber over.",
        model: "record-test-model",
        usage: { inputTokens: 8, outputTokens: 12, totalTokens: 20 },
      },
    ]);

    const result = await runLeadAgent(conversationId, { provider });
    expect(result.status).toBe("replied");
    expect(calls()).toBe(2);

    const rows = await usageRows(conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ totalTokens: 30, inputTokens: 13, outputTokens: 17 });
  });

  it("records the spend of a run that ends in a handoff", async () => {
    const { conversationId } = await conversationFor(businessPro);
    const { provider } = fakeProvider("record-handoff", [
      {
        model: "record-test-model",
        usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 },
        toolCalls: [
          { id: "c1", name: "handoffToHuman", arguments: { reason: "asked for a person" } },
        ],
      },
    ]);

    const result = await runLeadAgent(conversationId, { provider });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("handoff_requested");
    expect(result.usage?.totalTokens).toBe(8);

    const rows = await usageRows(conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ totalTokens: 8 });
    expect(await prisma.message.count({ where: { conversationId, sender: "AI" } })).toBe(0);
  });

  it("records nothing when the provider is disabled", async () => {
    const { conversationId } = await conversationFor(businessPro);

    const result = await runLeadAgent(conversationId, { provider: createDisabledProvider() });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("provider_disabled");
    expect(await usageRows(conversationId)).toHaveLength(0);
  });

  it("records nothing when the plan pre-flight refuses the run", async () => {
    // No subscription on this business → the run is refused before any call.
    const { conversationId } = await conversationFor(businessFree);
    const { provider, calls } = fakeProvider("never-run", [
      { text: "should not happen", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ]);

    const result = await runLeadAgent(conversationId, { provider });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("subscription_required");
    expect(calls()).toBe(0);
    expect(await usageRows(conversationId)).toHaveLength(0);
  });

  it("does not break a reply when persistence fails", async () => {
    const { conversationId } = await conversationFor(businessPro);
    const { provider } = fakeProvider("record-broken", [
      { text: "Thanks — what day suits?", usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } },
    ]);

    const spy = vi.spyOn(prisma.aiUsage, "create").mockRejectedValueOnce(new Error("db down"));
    try {
      const result = await runLeadAgent(conversationId, { provider });
      expect(result.status).toBe("replied");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("admin usage reporting (§49, step 32)", () => {
  const costlyConversation = { id: "", customerId: "" };

  let currentRunId: string;
  let oldRunId: string;

  beforeAll(async () => {
    const { conversationId, customerId } = await conversationFor(businessReport);
    costlyConversation.id = conversationId;
    costlyConversation.customerId = customerId;

    // This month's row: deliberately the most expensive fixture on the platform.
    currentRunId = (await seedUsage({
      businessId: businessReport,
      conversationId,
      provider: "openrouter",
      model: "report-model",
      inputTokens: 100,
      outputTokens: 100,
      totalTokens: 200,
      estimatedCost: 1.75,
    })).id;

    // Last month's row on the same tenant: outside the window, must be excluded.
    const now = new Date();
    oldRunId = (await seedUsage({
      businessId: businessReport,
      conversationId,
      provider: "openrouter",
      model: "report-model",
      inputTokens: 5_000,
      outputTokens: 5_000,
      totalTokens: 10_000,
      estimatedCost: 90,
      createdAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12)),
    })).id;
  });

  afterAll(async () => {
    // Rows are business-cascaded, but delete explicitly to keep totals right
    // for any suite that runs between here and the business deletion above.
    await prisma.aiUsage.deleteMany({ where: { id: { in: [currentRunId, oldRunId] } } });
  });

  it("reports per-business usage for the current month only", async () => {
    const res = await request(app).get("/api/v1/admin/usage").set("Cookie", admin.cookie);
    expect(res.status).toBe(200);

    const page = res.body.data;
    expect(page.period.start).toBeTruthy();
    expect(page.period.end).toBeTruthy();

    const row = page.usage.find(
      (entry: { business: { id: string } }) => entry.business.id === businessReport,
    );
    // The expensive fixture makes this tenant the costliest row on the page.
    expect(row).toMatchObject({
      business: { id: businessReport, status: "ACTIVE" },
      runs: 1,
      inputTokens: 100,
      outputTokens: 100,
      totalTokens: 200,
      estimatedCost: 1.75,
    });
    expect(row.lastUsedAt).toBeTruthy();

    // The platform summary includes this month's fixture, never last month's.
    expect(page.summary.runs).toBeGreaterThanOrEqual(1);
    expect(page.summary.estimatedCost).toBeGreaterThanOrEqual(1.75);
    expect(page.summary.estimatedCost).toBeLessThan(100);
    expect(page.summary.businesses).toBeGreaterThanOrEqual(1);
  });

  it("sorts the most expensive business first and paginates", async () => {
    const res = await request(app).get("/api/v1/admin/usage").set("Cookie", admin.cookie);
    const rows = res.body.data.usage as Array<{ estimatedCost: number }>;
    rows.forEach((row, index) => {
      const previous = rows[index - 1];
      if (previous) expect(previous.estimatedCost).toBeGreaterThanOrEqual(row.estimatedCost);
    });
  });

  it("searches by business name", async () => {
    const res = await request(app)
      .get(`/api/v1/admin/usage?search=${encodeURIComponent(`AI Usage Report ${stamp}`)}`)
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
    expect(
      res.body.data.usage.map((row: { business: { id: string } }) => row.business.id),
    ).toEqual([businessReport]);

    const none = await request(app)
      .get("/api/v1/admin/usage?search=does-not-exist-business")
      .set("Cookie", admin.cookie);
    expect(none.body.data.total).toBe(0);
    expect(none.body.data.usage).toEqual([]);
  });

  it("rejects a pageSize above the ceiling with 400", async () => {
    const res = await request(app)
      .get("/api/v1/admin/usage?pageSize=1000")
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("adds the per-business panel to the admin business detail", async () => {
    const res = await request(app)
      .get(`/api/v1/admin/businesses/${businessReport}`)
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(200);

    const aiUsage = res.body.data.business.aiUsage;
    expect(aiUsage.period.start).toBeTruthy();
    expect(aiUsage.totals).toEqual({
      runs: 1,
      inputTokens: 100,
      outputTokens: 100,
      totalTokens: 200,
      estimatedCost: 1.75,
    });
    expect(aiUsage.byModel).toEqual([
      expect.objectContaining({
        provider: "openrouter",
        model: "report-model",
        runs: 1,
        totalTokens: 200,
        estimatedCost: 1.75,
      }),
    ]);
  });

  it("scopes the business detail's usage to that tenant", async () => {
    const res = await request(app)
      .get(`/api/v1/admin/businesses/${businessPro}`)
      .set("Cookie", admin.cookie);

    const aiUsage = res.body.data.business.aiUsage;
    // The Pro fixture wrote no ai_usage rows for a fixed provenance id, and the
    // business-cascade deleted nothing yet — expect no openrouter rows here.
    expect(aiUsage.byModel.every((row: { provider: string }) => row.provider !== "never")).toBe(true);
    // And never another tenant's seeded row (provenance business ids).
    const openrouterRows = await prisma.aiUsage.findMany({
      where: { businessId: businessPro, provider: "openrouter" },
    });
    expect(openrouterRows).toEqual([]);
  });

  it("feeds the overview's AI usage and estimated cost", async () => {
    const before = await request(app).get("/api/v1/admin/overview").set("Cookie", admin.cookie);
    const base = before.body.data.overview;

    const extra = await seedUsage({
      businessId: businessReport,
      conversationId: costlyConversation.id,
      provider: "unit",
      model: "overview-model",
      inputTokens: 10,
      outputTokens: 10,
      totalTokens: 20,
      estimatedCost: 0.5,
    });

    try {
      const after = await request(app).get("/api/v1/admin/overview").set("Cookie", admin.cookie);
      const overview = after.body.data.overview;
      expect(overview.aiUsage).toEqual({
        runs: base.aiUsage.runs + 1,
        tokens: base.aiUsage.tokens + 20,
      });
      expect(overview.estimatedAiCost).toBeCloseTo(base.estimatedAiCost + 0.5, 6);
      expect(overview.mrr).toBeNull();
    } finally {
      await prisma.aiUsage.delete({ where: { id: extra.id } });
    }
  });
});