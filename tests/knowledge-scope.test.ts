import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAgentContext } from "../src/agents/context";
import { prisma } from "../src/lib/prisma";

/**
 * Knowledge scoping (IMPLEMENTATION_PLAN step 12's leftover, closed in step
 * 36): the AI context builder must load only the current business's knowledge
 * entries — active, not archived. A leaked entry from another business is a
 * tenant-isolation failure with teeth: the model would quote a competitor's
 * policies as this business's own (§13, §25).
 */

const stamp = Date.now();

let businessA: string;
let businessB: string;
let userId: string;

/** Business A's public FAQ — must reach the model. */
const A_FAQ = { question: `Do you service Edinburgh? (A${stamp})`, answer: `Yes, all of Edinburgh. A${stamp}` };
/** Another active entry for A — both must appear. */
const A_POLICY = { question: `What are your hours? (A${stamp})`, answer: `Eight to six. A${stamp}` };
/** A private/policy entry marked archived — must NOT reach the model. */
const A_ARCHIVED = { question: `Internal discount table (A${stamp})`, answer: `Staff-only. A${stamp}` };

/** Business B's entries — none may ever appear in A's context. */
const B_FAQ = { question: `Do you sell hot tubs? (B${stamp})`, answer: `Yes, hot tubs from £1,999. B${stamp}` };

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `knowledge-scope-${stamp}@example.com`, passwordHash: "not-used-in-this-test" },
  });
  userId = user.id;

  const [a, b] = await Promise.all([
    prisma.business.create({
      data: { name: `Knowledge Scope A ${stamp}`, type: "Plumber", currency: "GBP", locale: "en-GB" },
    }),
    prisma.business.create({
      data: { name: `Knowledge Scope B ${stamp}`, type: "Hot Tub Retailer", currency: "GBP", locale: "en-GB" },
    }),
  ]);
  businessA = a.id;
  businessB = b.id;

  await prisma.businessMember.createMany({
    data: [
      { businessId: businessA, userId, role: "OWNER" },
      { businessId: businessB, userId, role: "OWNER" },
    ],
  });

  await prisma.knowledgeEntry.createMany({
    data: [
      { businessId: businessA, ...A_FAQ, category: "FAQ" },
      { businessId: businessA, ...A_POLICY, category: "POLICY" },
      // Archived today — the model must not speak for a retired answer.
      { businessId: businessA, ...A_ARCHIVED, category: "FAQ", archivedAt: new Date() },
      { businessId: businessB, ...B_FAQ, category: "FAQ" },
    ],
  });
}, 60_000);

afterAll(async () => {
  await prisma.business.deleteMany({ where: { id: { in: [businessA, businessB] } } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

/** A conversation with one unanswered customer message in business A. */
async function seedConversation(business: string, customerName: string): Promise<string> {
  const customer = await prisma.customer.create({
    data: { businessId: business, name: customerName, phone: "07700 900111" },
  });
  const lead = await prisma.lead.create({
    data: { businessId: business, customerId: customer.id, customerMessage: "Are you available?" },
  });
  const conversation = await prisma.conversation.create({
    data: { businessId: business, customerId: customer.id, leadId: lead.id, channel: "WEBSITE", status: "AI_ACTIVE" },
  });
  await prisma.message.create({
    data: { conversationId: conversation.id, sender: "CUSTOMER", content: "Are you available?" },
  });
  return conversation.id;
}

describe("agent context knowledge scoping (step 12/36)", () => {
  it("loads only the business's own active entries", async () => {
    const conversationId = await seedConversation(businessA, `A Customer ${stamp}`);
    const context = await loadAgentContext(conversationId);
    expect(context).not.toBeNull();

    const questions = context!.knowledge.map((entry) => entry.question);
    expect(questions).toContain(A_FAQ.question);
    expect(questions).toContain(A_POLICY.question);
    // Archived stays private.
    expect(questions).not.toContain(A_ARCHIVED.question);
    // Business B never leaks.
    expect(questions).not.toContain(B_FAQ.question);

    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain(A_ARCHIVED.answer);
    expect(serialized).not.toContain(B_FAQ.answer);
    expect(serialized).not.toContain(businessB);
    expect(serialized).toContain(businessA);
  });

  it("keeps business B's context equally confined to its own entries", async () => {
    const conversationId = await seedConversation(businessB, `B Customer ${stamp}`);
    const context = await loadAgentContext(conversationId);
    expect(context).not.toBeNull();

    const questions = context!.knowledge.map((entry) => entry.question);
    expect(questions).toEqual([B_FAQ.question]);

    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain(A_FAQ.answer);
    expect(serialized).not.toContain(A_POLICY.answer);
    expect(serialized).not.toContain(A_ARCHIVED.answer);
    expect(serialized).not.toContain(businessA);
  });
});