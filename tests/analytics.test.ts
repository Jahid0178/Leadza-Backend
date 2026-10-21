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
let businessD: string;

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

// The fixture walks six leads through the status endpoint (~35 API calls
// against a remote dev DB) plus the §50 stats fixture — far longer than
// vitest's 10s default hook timeout.
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

  // ----- §50 fixture: fully known stats window math (step 33) -----
  // Business D reuses `owner` and is seeded straight via Prisma for speed:
  // the API-level funnel/transition validation is already exercised
  // end-to-end by business A above — D only needs controlled final states
  // and timestamps so the §50 aggregates have exact expected values.
  const statsBusiness = await prisma.business.create({
    data: { name: "Stats Fixture Drywall", type: "Drywall", timezone: "Europe/London" },
  });
  businessD = statsBusiness.id;
  await prisma.businessMember.create({
    data: { businessId: businessD, userId: owner.userId, role: "OWNER" },
  });
  const customerD = await prisma.customer.create({
    data: { businessId: businessD, name: "Jane Doe", phone: "07700 900333" },
  });

  // Funnel cohort: +40-day-old LOST and SPAM leads at the bottom.
  const longAgo = new Date(Date.now() - 40 * 86400000);
  await prisma.lead.createMany({
    data: [
      { businessId: businessD, customerId: customerD.id, source: "WEBSITE" }, // NEW
      { businessId: businessD, customerId: customerD.id, source: "WEBSITE", status: "QUALIFIED" },
      { businessId: businessD, customerId: customerD.id, source: "WHATSAPP", status: "BOOKED" },
      { businessId: businessD, customerId: customerD.id, source: "EMAIL", status: "WON" },
      { businessId: businessD, customerId: customerD.id, source: "FACEBOOK", status: "LOST", createdAt: longAgo },
      { businessId: businessD, customerId: customerD.id, source: "WEBSITE", status: "SPAM", createdAt: longAgo },
    ],
  });

  const minute = 60000;
  const seedMessage = (
    conversationId: string,
    sender: "CUSTOMER" | "AI" | "HUMAN" | "SYSTEM",
    at: number,
  ) =>
    prisma.message.create({
      data: { conversationId, sender, content: "seed message", createdAt: new Date(at) },
    });

  const base = new Date(Date.now() - 10 * 86400000);
  const conv2min = await prisma.conversation.create({
    data: { businessId: businessD, customerId: customerD.id, createdAt: base },
  });
  await seedMessage(conv2min.id, "CUSTOMER", base.getTime() + minute);
  await seedMessage(conv2min.id, "AI", base.getTime() + 3 * minute); // 2 min response

  const conv9min = await prisma.conversation.create({
    data: { businessId: businessD, customerId: customerD.id, createdAt: base },
  });
  await seedMessage(conv9min.id, "CUSTOMER", base.getTime() + minute);
  await seedMessage(conv9min.id, "HUMAN", base.getTime() + 10 * minute); // 9 min response

  // Never replied to — considered, but never counted toward the average.
  const convUnanswered = await prisma.conversation.create({
    data: { businessId: businessD, customerId: customerD.id, createdAt: base },
  });
  await seedMessage(convUnanswered.id, "CUSTOMER", base.getTime() + minute);
  await seedMessage(convUnanswered.id, "SYSTEM", base.getTime() + 2 * minute); // system ≠ reply

  // Two hours ago → inside every window; 5 min response.
  const conv5min = await prisma.conversation.create({
    data: {
      businessId: businessD,
      customerId: customerD.id,
      createdAt: new Date(Date.now() - 120 * minute),
    },
  });
  await seedMessage(conv5min.id, "CUSTOMER", Date.now() - 110 * minute);
  await seedMessage(conv5min.id, "AI", Date.now() - 105 * minute); // 5 min response
}, 240000);

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
          "Stats Fixture Drywall",
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

describe("GET /api/v1/analytics/stats (§50, step 33)", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/v1/analytics/stats");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("requires a businessId", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/stats")
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an invalid days window", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/stats")
      .query({ businessId: businessD, days: "999" })
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns the 30-day defaults: funnel, sources, response time, volume", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/stats")
      .query({ businessId: businessD })
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(200);
    const s = res.body.data.stats;

    // Window cohort = the four leads created today; the 40-day-old pair
    // (LOST, SPAM) is outside. Spam can't reach a stage, so cumulative
    // stages ignore it: 4 → 3 → 2 → 1, conversion 1/4 = 25%.
    expect(s.period.days).toBe(30);
    expect(s.period.start).toBeTruthy();
    expect(s.funnel.enquiries).toBe(4);
    expect(s.funnel.qualified).toBe(3);
    expect(s.funnel.booked).toBe(2);
    expect(s.funnel.won).toBe(1);
    expect(s.funnel.conversionRate).toBe(25);

    // Sources sorted by count, window scoped.
    expect(s.sources).toEqual([
      { source: "WEBSITE", count: 2 },
      { source: "WHATSAPP", count: 1 },
      { source: "EMAIL", count: 1 },
    ]);

    // (2 + 9 + 5)/3 = 5.33 → 5.3; the unanswered thread is excluded.
    expect(s.responseTime.respondedCount).toBe(3);
    expect(s.responseTime.averageMinutes).toBe(5.3);

    expect(s.totals).toEqual({ leads: 4, conversations: 4 });

    // One bucket per business-local day, continuous, ending today.
    expect(s.volume).toHaveLength(30);
    for (const day of s.volume) expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.timezone).toBeTruthy();
    const today = s.volume[s.volume.length - 1];
    expect(today.leads).toBe(4);
    expect(today.conversations).toBe(1);
    // The 10-day-back bucket holds the three backdated conversations.
    const withConversations = s.volume.filter((day: { conversations: number }) => day.conversations > 0);
    expect(withConversations).toHaveLength(2);
    expect(
      withConversations.find((day: { conversations: number }) => day.conversations === 3),
    ).toBeTruthy();
    expect(s.volume.reduce((sum: number, day: { leads: number }) => sum + day.leads, 0)).toBe(4);
    expect(
      s.volume.reduce((sum: number, day: { conversations: number }) => sum + day.conversations, 0),
    ).toBe(4);
  });

  it("widens to all time when days=all", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/stats")
      .query({ businessId: businessD, days: "all" })
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(200);
    const s = res.body.data.stats;

    // All-time cohort: the 40-day-old LOST and SPAM leads return. Spam is
    // excluded from enquiries (5) and from the rate denominator: 1/5 = 20%.
    expect(s.period.days).toBeNull();
    expect(s.period.start).toBeNull();
    expect(s.funnel.enquiries).toBe(5);
    expect(s.funnel.qualified).toBe(3);
    expect(s.funnel.booked).toBe(2);
    expect(s.funnel.won).toBe(1);
    expect(s.funnel.conversionRate).toBe(20);

    expect(s.sources).toEqual([
      { source: "WEBSITE", count: 3 },
      { source: "WHATSAPP", count: 1 },
      { source: "EMAIL", count: 1 },
      { source: "FACEBOOK", count: 1 },
    ]);

    expect(s.totals).toEqual({ leads: 6, conversations: 4 });

    // The series spans from the earliest activity to today (~41 buckets).
    expect(s.volume.length).toBeGreaterThanOrEqual(40);
    expect(s.volume.length).toBeLessThanOrEqual(42);
    expect(s.volume.reduce((sum: number, day: { leads: number }) => sum + day.leads, 0)).toBe(6);
    expect(
      s.volume.reduce((sum: number, day: { conversations: number }) => sum + day.conversations, 0),
    ).toBe(4);

    // Response time is conversation-based, so the wider window is the same.
    expect(s.responseTime.respondedCount).toBe(3);
    expect(s.responseTime.averageMinutes).toBe(5.3);
  });

  it("shrinks to the last 7 days", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/stats")
      .query({ businessId: businessD, days: "7" })
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(200);
    const s = res.body.data.stats;

    // Four today leads; the 10-day-old conversations drop out of both
    // response time and volume, leaving the 2-hour-old one.
    expect(s.funnel.enquiries).toBe(4);
    expect(s.funnel.won).toBe(1);
    expect(s.funnel.conversionRate).toBe(25);
    expect(s.totals).toEqual({ leads: 4, conversations: 1 });
    expect(s.responseTime.respondedCount).toBe(1);
    expect(s.responseTime.averageMinutes).toBe(5);
    expect(s.volume).toHaveLength(7);
    expect(
      s.volume.reduce((sum: number, day: { conversations: number }) => sum + day.conversations, 0),
    ).toBe(1);
    expect(
      s.volume.reduce((sum: number, day: { leads: number }) => sum + day.leads, 0),
    ).toBe(4);
  });

  it("answers null (not 0) when nothing was ever replied to", async () => {
    // Business A's only conversation has no messages at all.
    const res = await request(app)
      .get("/api/v1/analytics/stats")
      .query({ businessId: businessA })
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(200);
    const s = res.body.data.stats;
    expect(s.responseTime.averageMinutes).toBeNull();
    expect(s.responseTime.respondedCount).toBe(0);
    expect(s.totals.conversations).toBe(1);
  });

  it("lets a STAFF member read the stats", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/stats")
      .query({ businessId: businessA })
      .set("Cookie", staff.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.stats.totals.leads).toBe(6);
  });

  it("keeps another tenant's numbers out", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/stats")
      .query({ businessId: businessB })
      .set("Cookie", outsider.cookie);
    expect(res.status).toBe(200);
    const s = res.body.data.stats;
    expect(s.totals.leads).toBe(1);
    expect(s.totals.conversations).toBe(0);
    expect(s.sources).toEqual([{ source: "WEBSITE", count: 1 }]);
  });

  it("denies a foreign businessId with 404 (never leaks existence, §13)", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/stats")
      .query({ businessId: businessD })
      .set("Cookie", outsider.cookie);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("answers 404 for an unknown businessId", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/stats")
      .query({ businessId: "no-such-business" })
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns a clean zero state for a business with no data", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/stats")
      .query({ businessId: businessC })
      .set("Cookie", solo.cookie);
    expect(res.status).toBe(200);
    const s = res.body.data.stats;
    expect(s.funnel).toEqual({
      enquiries: 0,
      qualified: 0,
      booked: 0,
      won: 0,
      conversionRate: 0, // never NaN or Infinity
    });
    expect(s.responseTime).toEqual({ averageMinutes: null, respondedCount: 0 });
    expect(s.sources).toEqual([]);
    expect(s.totals).toEqual({ leads: 0, conversations: 0 });
    // A windowed view still carries its continuous zero-filled buckets…
    expect(s.volume).toHaveLength(30);
    expect(s.volume.every((day: { leads: number; conversations: number }) => day.leads === 0 && day.conversations === 0)).toBe(true);
    // …but the all-time view has no days to show at all.
    const all = await request(app)
      .get("/api/v1/analytics/stats")
      .query({ businessId: businessC, days: "all" })
      .set("Cookie", solo.cookie);
    expect(all.status).toBe(200);
    expect(all.body.data.stats.volume).toEqual([]);
  });
});
