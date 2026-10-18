import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeToolCall } from "../src/agents/tools/executor";
import type { ToolContext } from "../src/agents/tools/types";
import type { AiToolCall } from "../src/agents/provider";
import { prisma } from "../src/lib/prisma";

/**
 * AI tool tests (IMPLEMENTATION_PLAN step 21, agent.md §16, §41).
 *
 * Each tool is exercised through the executor against the real database, with
 * the context (businessId/leadId) resolved by the test as the backend would —
 * never from the model. The permission matrix is the point: a tool call that
 * names another tenant's resource must be denied.
 */

const stamp = Date.now();
let userId: string;
let businessId: string;
let customerId: string;
let serviceId: string;

// A second tenant, used only to prove cross-tenant calls are refused.
let otherBusinessId: string;
let otherLeadId: string;
let otherServiceId: string;

function call(name: string, args: unknown): AiToolCall {
  return { id: `call-${name}-${Math.random().toString(36).slice(2)}`, name, arguments: args };
}

/** A conversation + linked lead in the primary business. */
async function makeConversation(
  status: "AI_ACTIVE" | "HUMAN_REQUESTED" | "HUMAN_ACTIVE" = "AI_ACTIVE",
): Promise<{ conversationId: string; leadId: string }> {
  const lead = await prisma.lead.create({ data: { businessId, customerId } });
  const conversation = await prisma.conversation.create({
    data: { businessId, customerId, leadId: lead.id, channel: "WEBSITE", status },
  });
  return { conversationId: conversation.id, leadId: lead.id };
}

function context(conversationId: string, leadId: string | null): ToolContext {
  return { businessId, conversationId, customerId, leadId };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `ai-tools-${stamp}@example.com`, passwordHash: "not-used-in-this-test" },
  });
  userId = user.id;

  const business = await prisma.business.create({
    data: { name: `AI Tools Test ${stamp}`, type: "Plumber", currency: "GBP", locale: "en-GB" },
  });
  businessId = business.id;
  await prisma.businessMember.create({ data: { businessId, userId, role: "OWNER" } });

  const service = await prisma.service.create({
    data: { businessId, name: "Boiler Repair", price: 90, priceType: "FROM", active: true },
  });
  serviceId = service.id;

  await prisma.serviceArea.create({ data: { businessId, value: "RG1", label: "Reading" } });
  await prisma.businessHour.create({
    data: { businessId, weekday: "MONDAY", startTime: "09:00", endTime: "17:00" },
  });

  const customer = await prisma.customer.create({
    data: { businessId, name: "Test Customer", phone: "07700 900222", email: "test@example.com" },
  });
  customerId = customer.id;

  // Second tenant (no membership for this user).
  const other = await prisma.business.create({
    data: { name: `Other Business ${stamp}`, currency: "GBP", locale: "en-GB" },
  });
  otherBusinessId = other.id;
  const otherCustomer = await prisma.customer.create({
    data: { businessId: other.id, name: "Other Customer" },
  });
  const otherLead = await prisma.lead.create({
    data: { businessId: other.id, customerId: otherCustomer.id },
  });
  otherLeadId = otherLead.id;
  const otherService = await prisma.service.create({
    data: { businessId: other.id, name: "Other Service", price: 10 },
  });
  otherServiceId = otherService.id;
}, 60000);

afterAll(async () => {
  await prisma.business.deleteMany({ where: { id: { in: [businessId, otherBusinessId] } } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe("getBusinessInfo / getServiceDetails / checkServiceArea", () => {
  it("returns the business profile scoped to the conversation's business", async () => {
    const { conversationId, leadId } = await makeConversation();
    const { outcome } = await executeToolCall(
      context(conversationId, leadId),
      call("getBusinessInfo", {}),
    );
    expect(outcome.ok).toBe(true);
    const data = outcome.data as { name: string; serviceAreas: string[] };
    expect(data.name).toContain("AI Tools Test");
    expect(data.serviceAreas).toContain("Reading");
  });

  it("returns a service's price by name", async () => {
    const { conversationId, leadId } = await makeConversation();
    const { outcome } = await executeToolCall(
      context(conversationId, leadId),
      call("getServiceDetails", { serviceName: "boiler repair" }),
    );
    expect(outcome.ok).toBe(true);
    expect((outcome.data as { price: number }).price).toBe(90);
  });

  it("does not read another business's service", async () => {
    const { conversationId, leadId } = await makeConversation();
    const { outcome } = await executeToolCall(
      context(conversationId, leadId),
      call("getServiceDetails", { serviceId: otherServiceId }),
    );
    expect(outcome.ok).toBe(false);
  });

  it("confirms a covered postcode and rejects an unknown one", async () => {
    const { conversationId, leadId } = await makeConversation();
    const inArea = await executeToolCall(
      context(conversationId, leadId),
      call("checkServiceArea", { postcode: "RG1 4AB" }),
    );
    expect((inArea.outcome.data as { inArea: boolean }).inArea).toBe(true);

    const outArea = await executeToolCall(
      context(conversationId, leadId),
      call("checkServiceArea", { place: "Edinburgh" }),
    );
    expect((outArea.outcome.data as { inArea: boolean }).inArea).toBe(false);
  });
});

describe("updateLead permission matrix (§16, §41)", () => {
  it("updates the conversation's lead with validated fields", async () => {
    const { conversationId, leadId } = await makeConversation();
    const { outcome } = await executeToolCall(
      context(conversationId, leadId),
      call("updateLead", { urgency: "HIGH", postcode: "RG1 4AB", budget: 450 }),
    );
    expect(outcome.ok).toBe(true);

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.urgency).toBe("HIGH");
    expect(lead.postcode).toBe("RG1 4AB");
    expect(lead.budget).toBe(450);
  });

  it("DENIES a lead that belongs to another business", async () => {
    const { conversationId, leadId } = await makeConversation();
    const { outcome } = await executeToolCall(
      context(conversationId, leadId),
      call("updateLead", { leadId: otherLeadId, urgency: "HIGH" }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.denied).toBe(true);

    // The other tenant's lead is untouched.
    const other = await prisma.lead.findUniqueOrThrow({ where: { id: otherLeadId } });
    expect(other.urgency).toBeNull();

    const ledger = await prisma.aiToolCall.findFirst({
      where: { conversationId, tool: "updateLead" },
      orderBy: { createdAt: "desc" },
    });
    expect(ledger?.status).toBe("DENIED");
  });

  it("DENIES a service that belongs to another business", async () => {
    const { conversationId, leadId } = await makeConversation();
    const { outcome } = await executeToolCall(
      context(conversationId, leadId),
      call("updateLead", { serviceId: otherServiceId }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.denied).toBe(true);
  });

  it("DENIES malformed arguments before touching the database", async () => {
    const { conversationId, leadId } = await makeConversation();
    const { outcome } = await executeToolCall(
      context(conversationId, leadId),
      call("updateLead", { urgency: "URGENT" }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.denied).toBe(true);
  });
});

describe("calculateLeadScore", () => {
  it("stores a deterministic score for the conversation's lead", async () => {
    const { conversationId, leadId } = await makeConversation();
    await prisma.lead.update({
      where: { id: leadId },
      data: {
        serviceId,
        urgency: "HIGH",
        postcode: "RG1 4AB",
        budget: 500,
        preferredDate: new Date("2026-11-01T09:00:00Z"),
        customerMessage: "My boiler is leaking and I need it fixed soon please.",
      },
    });

    const { outcome } = await executeToolCall(
      context(conversationId, leadId),
      call("calculateLeadScore", {}),
    );
    expect(outcome.ok).toBe(true);
    const { score } = outcome.data as { score: number };
    expect(score).toBe(100); // all factors present

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.leadScore).toBe(score);
  });

  it("scores a bare enquiry lower", async () => {
    const { conversationId, leadId } = await makeConversation();
    const { outcome } = await executeToolCall(
      context(conversationId, leadId),
      call("calculateLeadScore", {}),
    );
    // Only phone (10) + email (5) are present for the seeded customer.
    expect((outcome.data as { score: number }).score).toBe(15);
  });
});

describe("handoffToHuman", () => {
  it("moves the conversation to HUMAN_REQUESTED", async () => {
    const { conversationId, leadId } = await makeConversation();
    const { outcome } = await executeToolCall(
      context(conversationId, leadId),
      call("handoffToHuman", { reason: "Customer asked for a person" }),
    );
    expect(outcome.ok).toBe(true);
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    expect(conversation.status).toBe("HUMAN_REQUESTED");
  });

  it("is idempotent once a human is already requested", async () => {
    const { conversationId, leadId } = await makeConversation("HUMAN_REQUESTED");
    const { outcome } = await executeToolCall(
      context(conversationId, leadId),
      call("handoffToHuman", {}),
    );
    expect(outcome.ok).toBe(true);
    expect((outcome.data as { alreadyRequested?: boolean }).alreadyRequested).toBe(true);
  });
});

describe("executor safety", () => {
  it("DENIES an unknown tool and records it in the ledger", async () => {
    const { conversationId, leadId } = await makeConversation();
    const { outcome } = await executeToolCall(
      context(conversationId, leadId),
      call("dropAllTables", {}),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.denied).toBe(true);

    const ledger = await prisma.aiToolCall.findFirst({
      where: { conversationId, tool: "dropAllTables" },
    });
    expect(ledger?.status).toBe("DENIED");
  });

  it("accepts JSON-string arguments as OpenAI sends them", async () => {
    const { conversationId, leadId } = await makeConversation();
    const { outcome } = await executeToolCall(
      context(conversationId, leadId),
      call("checkServiceArea", JSON.stringify({ postcode: "RG1 4AB" })),
    );
    expect(outcome.ok).toBe(true);
    expect((outcome.data as { inArea: boolean }).inArea).toBe(true);
  });
});

describe("checkAvailability / createBooking (§34–35)", () => {
  const window = () => {
    const from = new Date();
    return { from, to: new Date(from.getTime() + 14 * 24 * 60 * 60 * 1000) };
  };

  async function firstSlot(conversationId: string, leadId: string, index = 0) {
    const { from, to } = window();
    const { outcome } = await executeToolCall(
      { businessId, conversationId, customerId, leadId },
      call("checkAvailability", { from: from.toISOString(), to: to.toISOString() }),
    );
    expect(outcome.ok).toBe(true);
    const data = outcome.data as {
      timezone: string;
      slots: { startAt: string; endAt: string; time: string }[];
      allowedTimes: string[];
    };
    expect(data.allowedTimes).toContain(data.slots[0]?.time);
    return { slot: data.slots[index], data };
  }

  it("returns real slots and the times the reply may state", async () => {
    const { conversationId, leadId } = await makeConversation();
    const { data } = await firstSlot(conversationId, leadId);
    expect(data.slots.length).toBeGreaterThan(0);
    expect(data.allowedTimes.length).toBeGreaterThan(0);
    expect(data.timezone).toBeTruthy();
  });

  it("returns no slots for a window entirely in the past", async () => {
    const { conversationId, leadId } = await makeConversation();
    const to = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const from = new Date(to.getTime() - 5 * 24 * 60 * 60 * 1000);
    const { outcome } = await executeToolCall(
      { businessId, conversationId, customerId, leadId },
      call("checkAvailability", { from: from.toISOString(), to: to.toISOString() }),
    );
    expect(outcome.ok).toBe(true);
    expect((outcome.data as { slots: unknown[] }).slots).toEqual([]);
  });

  it("DENIES a range whose end is not after its start", async () => {
    const { conversationId, leadId } = await makeConversation();
    const at = new Date().toISOString();
    const { outcome } = await executeToolCall(
      { businessId, conversationId, customerId, leadId },
      call("checkAvailability", { from: at, to: at }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.denied).toBe(true);
  });

  it("books an agreed slot as PENDING and advances the lead to BOOKED", async () => {
    const { conversationId, leadId } = await makeConversation();
    await prisma.lead.update({ where: { id: leadId }, data: { status: "QUALIFIED" } });

    const { slot } = await firstSlot(conversationId, leadId, 0);
    const { outcome } = await executeToolCall(
      { businessId, conversationId, customerId, leadId },
      call("createBooking", { startAt: slot!.startAt }),
    );
    expect(outcome.ok).toBe(true);
    const data = outcome.data as { booking: { status: string }; allowedTimes: string[] };
    expect(data.booking.status).toBe("PENDING");
    expect(data.allowedTimes).toContain(slot!.time);

    const booking = await prisma.booking.findFirst({
      where: { businessId, leadId },
      orderBy: { createdAt: "desc" },
    });
    expect(booking?.origin).toBe("AI");
    expect(booking?.createdById).toBeNull();

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.status).toBe("BOOKED");
  });

  it("refuses to double-book a slot the AI already took", async () => {
    const { conversationId, leadId } = await makeConversation();
    const { slot } = await firstSlot(conversationId, leadId, 3);

    const first = await executeToolCall(
      { businessId, conversationId, customerId, leadId },
      call("createBooking", { startAt: slot!.startAt }),
    );
    expect(first.outcome.ok).toBe(true);

    const second = await executeToolCall(
      { businessId, conversationId, customerId, leadId },
      call("createBooking", { startAt: slot!.startAt }),
    );
    expect(second.outcome.ok).toBe(false);
  });

  it("DENIES a booking when the conversation has no customer", async () => {
    const { conversationId, leadId } = await makeConversation();
    const { outcome } = await executeToolCall(
      { businessId, conversationId, customerId: "", leadId },
      call("createBooking", {
        startAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.denied).toBe(true);
  });
});
