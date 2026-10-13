import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";

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
  const email = `${label}-${stamp}@example.com`;
  const res = await request(app)
    .post("/api/v1/auth/register")
    .send({ name: `Actor ${label}`, email, password });
  if (res.status !== 201) {
    throw new Error(`register failed for ${label}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { email, cookie: sessionCookieFrom(res), userId: res.body.data.user.id as string };
}

// Fixture: business A (owner + staff) with a full funnel; business B owned by
// an outsider with one lead (leak check); business C empty (zero state).
let owner: Actor;
let staff: Actor;
let outsider: Actor;
let solo: Actor;
let businessA: string;
let businessB: string;
let businessC: string;

/** Create a customer in a business and return its id. */
async function seedCustomer(actor: Actor, businessId: string, phone: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/customers")
    .set("Cookie", actor.cookie)
    .send({ businessId, name: "Jane Doe", phone });
  if (res.status !== 201) throw new Error(`customer create failed: ${res.status}`);
  return res.body.data.customer.id as string;
}

/** Create a lead in a business and return its id. */
async function seedLead(actor: Actor, businessId: string, customerId: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/leads")
    .set("Cookie", actor.cookie)
    .send({ businessId, customerId, source: "WEBSITE" });
  if (res.status !== 201) throw new Error(`lead create failed: ${res.status}`);
  return res.body.data.lead.id as string;
}

/** Drive a lead to a terminal/advanced status via the public status endpoint. */
async function driveLead(actor: Actor, leadId: string, path: string[]) {
  for (const status of path) {
    const res = await request(app)
      .patch(`/api/v1/leads/${leadId}/status`)
      .set("Cookie", actor.cookie)
      .send({ status });
    if (res.status !== 200) {
      throw new Error(`status move to ${status} failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
  }
}

// The fixture walks six leads through the status endpoint (~35 API calls)
// — longer than vitest's 10s default hook timeout.
beforeAll(async () => {
  [owner, staff, outsider, solo] = await Promise.all([
    registerActor("aowner"),
    registerActor("astf"),
    registerActor("aout"),
    registerActor("asolo"),
  ]);

  const create = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", owner.cookie)
    .send({ name: "Analytics Test Plumbing", type: "Plumber" });
  if (create.status !== 201) throw new Error(`business create failed: ${JSON.stringify(create.body)}`);
  businessA = create.body.data.business.id as string;

  const foreign = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", outsider.cookie)
    .send({ name: "Foreign Analytics Heating", type: "Heating" });
  businessB = foreign.body.data.business.id as string;

  const empty = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", solo.cookie)
    .send({ name: "Empty Analytics Co", type: "Plumber" });
  businessC = empty.body.data.business.id as string;

  await prisma.businessMember.create({
    data: { businessId: businessA, userId: staff.userId, role: "STAFF" },
  });

  const customerA = await seedCustomer(owner, businessA, "07700 900311");

  // Full funnel on business A: 1 NEW, 1 QUALIFIED, 1 BOOKED, 1 WON, 1 LOST,
  // 1 SPAM → total 6, spam 1, eligible 5, conversion 1/5 = 20%.
  await seedLead(owner, businessA, customerA); // stays NEW
  const qualified = await seedLead(owner, businessA, customerA);
  await driveLead(owner, qualified, ["CONTACTED", "QUALIFYING", "QUALIFIED"]);
  const booked = await seedLead(owner, businessA, customerA);
  await driveLead(owner, booked, ["CONTACTED", "QUALIFYING", "QUALIFIED", "BOOKED"]);
  const won = await seedLead(owner, businessA, customerA);
  await driveLead(owner, won, ["CONTACTED", "QUALIFYING", "QUALIFIED", "BOOKED", "WON"]);
  const lost = await seedLead(owner, businessA, customerA);
  await driveLead(owner, lost, ["CONTACTED", "LOST"]);
  const spam = await seedLead(owner, businessA, customerA);
  await driveLead(owner, spam, ["SPAM"]);

  // One customer waiting on a human (needs attention).
  const conversation = await request(app)
    .post("/api/v1/conversations")
    .set("Cookie", owner.cookie)
    .send({ businessId: businessA, customerId: customerA });
  if (conversation.status !== 201) throw new Error("conversation create failed");
  const moved = await request(app)
    .patch(`/api/v1/conversations/${conversation.body.data.conversation.id}/status`)
    .set("Cookie", owner.cookie)
    .send({ status: "HUMAN_REQUESTED" });
  if (moved.status !== 200) throw new Error("conversation move failed");

  // Foreign business B gets its own lead — must never appear in A's numbers.
  const customerB = await seedCustomer(outsider, businessB, "07700 900322");
  await seedLead(outsider, businessB, customerB);
}, 60000);

afterAll(async () => {
  const ids = [owner, staff, outsider, solo].map((a) => a.userId);
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.business.deleteMany({
    where: {
      name: {
        in: [
          "Analytics Test Plumbing",
          "Foreign Analytics Heating",
          "Empty Analytics Co",
        ],
      },
    },
  });
});

describe("GET /api/v1/analytics/dashboard (§28, step 17)", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/v1/analytics/dashboard");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("requires a businessId", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/dashboard")
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns the funnel counts, conversion rate and attention totals", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/dashboard")
      .query({ businessId: businessA })
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(200);
    const d = res.body.data.dashboard;

    expect(d.newLeads).toBe(1);
    expect(d.qualified).toBe(3); // QUALIFIED + BOOKED + WON (cumulative)
    expect(d.booked).toBe(2); // BOOKED + WON (cumulative)
    expect(d.won).toBe(1);
    expect(d.total).toBe(6);
    // Spam is excluded from the denominator: 1 won / 5 eligible = 20%.
    expect(d.conversionRate).toBe(20);
    expect(d.humanRequestedConversations).toBe(1);
    expect(d.needsAttention).toBe(2); // 1 NEW lead + 1 human-requested thread
  });

  it("lists recent leads and the attention items with customers attached", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/dashboard")
      .query({ businessId: businessA })
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(200);
    const d = res.body.data.dashboard;

    expect(d.recentLeads).toHaveLength(5); // capped at the latest 5 of 6
    expect(d.recentLeads[0].customer.name).toBe("Jane Doe");
    expect(d.attentionLeads).toHaveLength(1); // the single NEW lead
    expect(d.attentionLeads[0].status).toBe("NEW");
    expect(d.humanRequested).toHaveLength(1);
    expect(d.humanRequested[0].status).toBe("HUMAN_REQUESTED");
  });

  it("lets a STAFF member read the dashboard", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/dashboard")
      .query({ businessId: businessA })
      .set("Cookie", staff.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.dashboard.total).toBe(6);
  });

  it("keeps another tenant's numbers out (business B isolated)", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/dashboard")
      .query({ businessId: businessB })
      .set("Cookie", outsider.cookie);
    expect(res.status).toBe(200);
    const d = res.body.data.dashboard;
    expect(d.total).toBe(1);
    expect(d.newLeads).toBe(1);
    // No lead or customer from business A leaks into B.
    for (const lead of d.recentLeads) {
      expect(lead.customer.phone).toBe("07700 900322");
    }
  });

  it("denies a foreign businessId with 404 (never leaks existence, §13)", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/dashboard")
      .query({ businessId: businessA })
      .set("Cookie", outsider.cookie);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("answers 404 for an unknown businessId", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/dashboard")
      .query({ businessId: "no-such-business" })
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns zeroes for a business with no leads", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/dashboard")
      .query({ businessId: businessC })
      .set("Cookie", solo.cookie);
    expect(res.status).toBe(200);
    const d = res.body.data.dashboard;
    expect(d.newLeads).toBe(0);
    expect(d.qualified).toBe(0);
    expect(d.booked).toBe(0);
    expect(d.won).toBe(0);
    expect(d.total).toBe(0);
    // No data → 0%, never NaN or Infinity.
    expect(d.conversionRate).toBe(0);
    expect(d.needsAttention).toBe(0);
    expect(d.recentLeads).toEqual([]);
    expect(d.attentionLeads).toEqual([]);
    expect(d.humanRequested).toEqual([]);
  });
});
