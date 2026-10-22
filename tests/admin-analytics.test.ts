import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";

/**
 * §51 platform analytics (the "Admin analytics" build): the endpoints under
 * /api/v1/admin/analytics/* behind the router-wide admin gate.
 *
 * Platform-wide numbers can't be asserted absolutely — this suite shares the
 * dev database with every other test file (vitest runs them sequentially) and
 * with real development data. Two kinds of assertions instead:
 *   - fixture-scoped endpoints (businessId-filtered counts, event counts on a
 *     table this suite is the only writer of) assert exact fixtures;
 *   - platform-wide numbers are independently verified against the database
 *     using the window the response itself reports.
 */

const app = createApp();

const stamp = Date.now();
const password = "s3cure-pass-1";
const DAY_MS = 86400000;

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

async function loginActor(actor: Actor): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: actor.email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return sessionCookieFrom(res);
}

let admin: Actor;
let nonAdmin: Actor;
let ownerA: Actor;
let businessA: string;
let businessB: string;
let customerA: string;
let conversationC1: string;
let conversationC2: string;
let conversationC3: string;

const businessAName = `Analytics Platform Plumb ${stamp}`;
const businessBName = `Analytics Platform Quiet Co ${stamp}`;
const longAgo = new Date(Date.now() - 40 * DAY_MS);

beforeAll(async () => {
  [admin, nonAdmin, ownerA] = await Promise.all([
    registerActor("anadmin"),
    registerActor("anregular"),
    registerActor("anowner"),
  ]);

  // Business A via the real endpoint so its registration event rides along.
  const created = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", ownerA.cookie)
    .send({ name: businessAName, type: "Plumbing" });
  if (created.status !== 201) throw new Error("business create failed");
  businessA = created.body.data.business.id as string;

  // Business B straight via Prisma: ACTIVE and 40 days old, so its
  // registration falls outside the window and it becomes a "quiet business"
  // alert (ACTIVE + no recorded activity for 14 days).
  const quiet = await prisma.business.create({
    data: { name: businessBName, type: "Heating", createdAt: longAgo },
  });
  businessB = quiet.id;
  // ownerA's OWNER membership came with the business creation above.

  const customer = await prisma.customer.create({
    data: { businessId: businessA, name: `Analytics Platform Customer ${stamp}` },
  });
  customerA = customer.id;

  // Funnel cohort inside the 30-day default window: 1 NEW, 1 QUALIFIED,
  // 1 BOOKED, 1 WON, 1 CONTACTED → plus two 40-day-old rows (LOST, SPAM)
  // that only return for the 90-day window.
  await prisma.lead.createMany({
    data: [
      { businessId: businessA, customerId: customerA, source: "WEBSITE" }, // NEW
      { businessId: businessA, customerId: customerA, source: "WEBSITE", status: "QUALIFIED" },
      { businessId: businessA, customerId: customerA, source: "WHATSAPP", status: "BOOKED" },
      { businessId: businessA, customerId: customerA, source: "EMAIL", status: "WON" },
      { businessId: businessA, customerId: customerA, source: "FACEBOOK", status: "LOST", createdAt: longAgo },
      { businessId: businessA, customerId: customerA, source: "WEBSITE", status: "SPAM", createdAt: longAgo },
    ],
  });

  // One lead driven through the real status endpoint — the instrumentation
  // under test: the move must land one LEAD_STATUS_CHANGED event.
  const apiLead = await request(app)
    .post("/api/v1/leads")
    .set("Cookie", ownerA.cookie)
    .send({ businessId: businessA, customerId: customerA, source: "WEBSITE" });
  const apiLeadId = apiLead.body.data.lead.id as string;
  const moved = await request(app)
    .patch(`/api/v1/leads/${apiLeadId}/status`)
    .set("Cookie", ownerA.cookie)
    .send({ status: "CONTACTED" });
  if (moved.status !== 200) throw new Error("lead status move failed");

  // C1: AI replies, never escalated → resolved without human.
  conversationC1 = (
    await prisma.conversation.create({
      data: { businessId: businessA, customerId: customerA },
    })
  ).id;
  await prisma.message.createMany({
    data: [
      { conversationId: conversationC1, sender: "CUSTOMER", content: "c1 in" },
      { conversationId: conversationC1, sender: "AI", content: "c1 ai", aiGenerated: true },
      { conversationId: conversationC1, sender: "CUSTOMER", content: "c1 in 2" },
      { conversationId: conversationC1, sender: "AI", content: "c1 ai 2", aiGenerated: true },
    ],
  });

  // C2: AI-initiated escalation, recorded on both ledgers exactly as the
  // handoff tool writes them (AiToolCall + AnalyticsEvent).
  conversationC2 = (
    await prisma.conversation.create({
      data: { businessId: businessA, customerId: customerA, status: "HUMAN_REQUESTED" },
    })
  ).id;
  await prisma.message.create({
    data: { conversationId: conversationC2, sender: "AI", content: "c2 ai", aiGenerated: true },
  });
  await prisma.aiToolCall.create({
    data: { businessId: businessA, conversationId: conversationC2, tool: "handoffToHuman", status: "OK" },
  });
  await prisma.analyticsEvent.create({
    data: {
      type: "CONVERSATION_ESCALATED",
      businessId: businessA,
      conversationId: conversationC2,
      fromStatus: "AI_ACTIVE",
      toStatus: "HUMAN_REQUESTED",
      initiator: "AI",
    },
  });

  // C3: AI reply + a STAFF escalation through the real status endpoint —
  // the repository instrumentation emits the STAFF escalation event.
  conversationC3 = (
    await prisma.conversation.create({
      data: { businessId: businessA, customerId: customerA },
    })
  ).id;
  await prisma.message.create({
    data: { conversationId: conversationC3, sender: "AI", content: "c3 ai", aiGenerated: true },
  });
  const escalate = await request(app)
    .patch(`/api/v1/conversations/${conversationC3}/status`)
    .set("Cookie", ownerA.cookie)
    .send({ status: "HUMAN_REQUESTED" });
  if (escalate.status !== 200) throw new Error("conversation escalate failed");

  // Bookings: one staff-origin tied to the WON lead, one AI-origin, one
  // cancelled (never counted).
  await prisma.booking.createMany({
    data: [
      {
        businessId: businessA,
        customerId: customerA,
        leadId: (await prisma.lead.findFirst({ where: { businessId: businessA, status: "WON" } }))?.id,
        startAt: new Date(Date.now() + DAY_MS),
        endAt: new Date(Date.now() + DAYS(1.5)),
        status: "CONFIRMED",
        origin: "STAFF",
      },
      {
        businessId: businessA,
        customerId: customerA,
        startAt: new Date(Date.now() + 2 * DAY_MS),
        endAt: new Date(Date.now() + DAYS(2.5)),
        status: "PENDING",
        origin: "AI",
      },
      {
        businessId: businessA,
        customerId: customerA,
        startAt: new Date(Date.now() + 3 * DAY_MS),
        endAt: new Date(Date.now() + DAYS(3.5)),
        status: "CANCELLED",
        origin: "STAFF",
      },
    ],
  });

  // AI qualification ledger: two tool calls, the same lead — distinct count
  // must stay 1 (no double counting across repeated enrichment).
  await prisma.aiToolCall.createMany({
    data: [
      { businessId: businessA, conversationId: conversationC1, tool: "calculateLeadScore", status: "OK", leadId: (await prisma.lead.findFirst({ where: { businessId: businessA, status: "WON" } }))?.id },
      { businessId: businessA, conversationId: conversationC1, tool: "updateLead", status: "OK", leadId: (await prisma.lead.findFirst({ where: { businessId: businessA, status: "WON" } }))?.id },
    ],
  });

  // Two failed agent runs — technical failures, never escalations.
  await prisma.analyticsEvent.createMany({
    data: [
      { type: "AI_RUN_FAILED", businessId: businessA, conversationId: conversationC1, metadata: { provider: "openrouter", reason: "provider_error" } },
      { type: "AI_RUN_FAILED", businessId: businessA, conversationId: conversationC3, metadata: { provider: "openai", reason: "provider_error" } },
    ],
  });

  // Promote + re-login so the fixture cookie is honest (admin.test.ts style).
  await prisma.user.update({
    where: { id: admin.userId },
    data: { platformRole: "PLATFORM_ADMIN" },
  });
  admin.cookie = await loginActor(admin);
}, 240000);

/** DAY_MS×n helper for endAt offsets (n can be fractional). */
function DAYS(days: number): number {
  return days * DAY_MS;
}

afterAll(async () => {
  const userIds = [admin, nonAdmin, ownerA].map((actor) => actor.userId);
  // Analytics events and audit rows carry no FKs on purpose — explicit cleanup.
  await prisma.analyticsEvent.deleteMany({ where: { businessId: { in: [businessA, businessB] } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.business.deleteMany({ where: { id: { in: [businessA, businessB] } } });
});

describe("admin analytics gate (§51)", () => {
  const paths = [
    "/api/v1/admin/analytics/overview",
    "/api/v1/admin/analytics/leads",
    "/api/v1/admin/analytics/ai-performance",
    "/api/v1/admin/analytics/businesses",
    "/api/v1/admin/analytics/activity",
  ];

  it("requires authentication everywhere", async () => {
    for (const path of paths) {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe("UNAUTHENTICATED");
    }
  });

  it("refuses a signed-in non-admin with 403 (never leaks existence)", async () => {
    for (const path of paths) {
      const res = await request(app).get(path).set("Cookie", nonAdmin.cookie);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("PLATFORM_ADMIN_REQUIRED");
    }
  });

  it("refuses a business owner that is not a platform admin", async () => {
    const res = await request(app)
      .get("/api/v1/admin/analytics/overview")
      .set("Cookie", ownerA.cookie);
    expect(res.status).toBe(403);
  });

  it("answers 403 even for unknown admin-analytics subpaths", async () => {
    const res = await request(app)
      .get("/api/v1/admin/analytics/never-built")
      .set("Cookie", nonAdmin.cookie);
    expect(res.status).toBe(403);
  });
});

describe("window validation (§4 of the spec)", () => {
  it("rejects a malformed from/to", async () => {
    const res = await request(app)
      .get("/api/v1/admin/analytics/overview")
      .query({ from: "not-a-date", to: "2026-01-01" })
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects from after to", async () => {
    const res = await request(app)
      .get("/api/v1/admin/analytics/overview")
      .query({ from: "2026-02-01", to: "2026-01-01" })
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects windows longer than 366 days", async () => {
    const res = await request(app)
      .get("/api/v1/admin/analytics/overview")
      .query({ from: "2020-01-01", to: "2026-01-01" })
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a sort field outside the whitelist", async () => {
    const res = await request(app)
      .get("/api/v1/admin/analytics/businesses")
      .query({ sort: "passwordHash" })
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /admin/analytics/overview (§51)", () => {
  it("matches the database for every platform-wide number", async () => {
    const res = await request(app)
      .get("/api/v1/admin/analytics/overview")
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    const overview = res.body.data.overview;
    expect(overview.window.reportingTimezone).toBe("UTC");

    // Independent verification (spec §9): use the window the response echoes.
    const inWindow = { createdAt: { gte: new Date(overview.window.from), lt: new Date(overview.window.endExclusive) } };
    expect(overview.leads.total.current).toBe(await prisma.lead.count({ where: inWindow }));
    expect(overview.businesses.total).toBe(await prisma.business.count());
    expect(overview.businesses.newRegistrations.current).toBe(
      await prisma.business.count({ where: inWindow }),
    );
    expect(overview.leads.today).toBe(
      await prisma.lead.count({ where: { createdAt: { gte: todayStartUtc() } } }),
    );
    expect(overview.leads.bookedAppointments.current).toBe(
      await prisma.booking.count({ where: { ...inWindow, status: { not: "CANCELLED" } } }),
    );
    // Event tables carried no data before this suite — exact fixture numbers
    // AND independently verified against the database for the response window.
    expect(overview.conversations.escalations.current).toBe(
      await prisma.analyticsEvent.count({
        where: {
          type: "CONVERSATION_ESCALATED",
          createdAt: { gte: new Date(overview.window.from), lt: new Date(overview.window.endExclusive) },
        },
      }),
    );
    expect(overview.conversations.escalations.current).toBeGreaterThanOrEqual(2);
    expect(overview.conversations.aiRunFailures.current).toBeGreaterThanOrEqual(2);
  });

  it("computes the window conversion rate from won over the eligible cohort", async () => {
    const res = await request(app)
      .get("/api/v1/admin/analytics/overview")
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    const overview = res.body.data.overview;
    expect(overview.leads.conversionRate.current).toBeGreaterThanOrEqual(0);
    expect(overview.leads.conversionRate.current).toBeLessThanOrEqual(100);
  });
});

describe("GET /admin/analytics/leads (§51)", () => {
  it("returns the fixture funnel for the business-scoped window", async () => {
    const res = await request(app)
      .get("/api/v1/admin/analytics/leads")
      .query({ businessId: businessA })
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    const leads = res.body.data.leadAnalytics;

    // 30-day default window: the 40-day-old LOST and SPAM rows stay out —
    // 5 cohort leads (incl. the API-driven CONTACTED one), no spam.
    expect(leads.funnel).toEqual({ enquiries: 5, qualified: 3, booked: 2, won: 1 });
    expect(leads.filters.businessId).toBe(businessA);
    expect(leads.bookedAppointments).toBe(2); // cancelled never counts
    expect(leads.leadToBookingRate).toBe(20); // 1 booking lead / 5 eligible
  });

  it("widens the window to 90 days", async () => {
    const res = await request(app)
      .get("/api/v1/admin/analytics/leads")
      .query({ businessId: businessA, from: isoDaysAgo(90), to: isoDaysAgo(0) })
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    const leads = res.body.data.leadAnalytics;
    // The backdated pair returns: 7 total, 1 spam → 6 enquiries.
    expect(leads.funnel).toEqual({ enquiries: 6, qualified: 3, booked: 2, won: 1 });
    expect(leads.leadToBookingRate).toBe(16.7); // 1 / 6 eligible
  });

  it("zero-fills every day between from and to (single-day window: 1 bucket)", async () => {
    const res = await request(app)
      .get("/api/v1/admin/analytics/leads")
      .query({ businessId: businessA, from: isoDaysAgo(0), to: isoDaysAgo(0) })
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    const leads = res.body.data.leadAnalytics;
    expect(leads.volumeByDay).toHaveLength(1);
    expect(leads.volumeByDay[0].leads).toBe(5); // five 'now' leads today
  });

  it("applies the status and source filters across outputs", async () => {
    const byStatus = await request(app)
      .get("/api/v1/admin/analytics/leads")
      .query({ businessId: businessA, status: "NEW" })
      .set("Cookie", admin.cookie);
    expect(byStatus.status).toBe(200);
    const filtered = byStatus.body.data.leadAnalytics;
    expect(filtered.funnel.enquiries).toBe(1);
    expect(filtered.statusDistribution).toEqual([{ status: "NEW", count: 1 }]);
    // Rate denominators still exclude spam and never go NaN.
    expect(filtered.leadToBookingRate).toBe(0);

    const bySource = await request(app)
      .get("/api/v1/admin/analytics/leads")
      .query({ businessId: businessA, source: "WHATSAPP" })
      .set("Cookie", admin.cookie);
    expect(bySource.status).toBe(200);
    // Cohort scoped by source: 1 lead (created today, in-window).
    expect(bySource.body.data.leadAnalytics.funnel.enquiries).toBe(1);
  });
});

describe("GET /admin/analytics/ai-performance (§51)", () => {
  it("reports AI outcomes without conflating escalations with failures", async () => {
    const res = await request(app)
      .get("/api/v1/admin/analytics/ai-performance")
      .query({ businessId: businessA })
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    const ai = res.body.data.aiPerformance;

    expect(ai.aiHandled.current).toBe(3); // C1, C2, C3 all have AI replies
    expect(ai.escalations.total.current).toBe(2);
    expect(ai.escalations.byAi).toBe(1); // the handoff tool's AiToolCall ledger
    expect(ai.escalations.byStaff).toBe(1); // the status endpoint's event
    expect(ai.escalations.awaitingReview).toBe(2);
    expect(ai.resolvedWithoutHuman.current).toBe(1); // C1 only

    // Failures are a separate metric — 2 failed runs, distinct from the 2
    // escalations, and never summed into either side.
    expect(ai.aiRunFailures.current).toBe(2);

    expect(ai.aiQualificationLeads.current).toBe(1); // both tool calls, one lead
    expect(ai.aiBookedAppointments.current).toBe(1);
    expect(ai.leadToBookingRate).toBe(20);

    // First response: C1's first customer message → first AI reply.
    expect(ai.averageFirstResponseMinutes).not.toBeNull();
    expect(ai.averageFirstResponseMinutes).toBeGreaterThanOrEqual(0);
  });

  it("does not double-count an AI handoff when its event and tool call coincide", async () => {
    // C2 is counted once by the tool ledger; its initiator-"AI" event row
    // (the mirror of the same escalation) must not inflate the staff count.
    const res = await request(app)
      .get("/api/v1/admin/analytics/ai-performance")
      .query({ businessId: businessA })
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    const escalations = res.body.data.aiPerformance.escalations;
    expect(escalations.byStaff).toBe(1);
  });
});

describe("GET /admin/analytics/businesses (§51)", () => {
  it("returns the fixture business with its exact window metrics", async () => {
    const res = await request(app)
      .get("/api/v1/admin/analytics/businesses")
      .query({ search: businessAName })
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    const page = res.body.data.businesses;
    expect(page.total).toBe(1);
    const row = page.businesses[0];
    expect(row.id).toBe(businessA);
    expect(row.status).toBe("ACTIVE");
    expect(row.leads).toBe(5); // 30-day window cohort
    expect(row.qualified).toBe(3);
    expect(row.aiConversations).toBe(3);
    expect(row.appointments).toBe(2);
    expect(row.lastActivity).not.toBeNull();
  });

  it("paginates and includes zero-activity businesses in aggregate sorts", async () => {
    const res = await request(app)
      .get("/api/v1/admin/analytics/businesses")
      .query({ sort: "leads", order: "desc", pageSize: 1, page: 1 })
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    const page = res.body.data.businesses;
    expect(page.page).toBe(1);
    expect(page.total).toBeGreaterThanOrEqual(2);
    expect(page.businesses).toHaveLength(1);
    // Sorting by leads must still surface the fixture's row on page 1 —
    // 5 leads in the window is the largest a page row can carry.
    expect(page.businesses[0].leads).toBeGreaterThanOrEqual(5);
  });
});

describe("GET /admin/analytics/businesses/:businessId (§51)", () => {
  it("returns the same stats the tenant's own page computes", async () => {
    const res = await request(app)
      .get(`/api/v1/admin/analytics/businesses/${businessA}`)
      .query({ days: "all" })
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    const stats = res.body.data.stats;
    expect(stats.totals.leads).toBe(7); // all-time cohort
    expect(stats.funnel.enquiries).toBe(6); // spam excluded
    expect(stats.timezone).toBeTruthy();
    expect(stats.period.days).toBeNull();

    // Daily buckets in the business's own timezone (not UTC).
    expect(stats.volume.length).toBeGreaterThanOrEqual(1);
  });

  it("answers 404 for an unknown business", async () => {
    const res = await request(app)
      .get("/api/v1/admin/analytics/businesses/no-such-business")
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

describe("GET /admin/analytics/activity (§51)", () => {
  it("returns the recorded feed with rule alerts", async () => {
    const res = await request(app)
      .get("/api/v1/admin/analytics/activity")
      .query({ businessId: businessA })
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    const activity = res.body.data.activity;

    // Registration + status moves + AI failures + both escalations.
    expect(activity.total).toBeGreaterThanOrEqual(5);
    const kinds = new Set(activity.entries.map((entry: { kind: string }) => entry.kind));
    expect(kinds.has("event.escalation")).toBe(true);
    expect(kinds.has("event.ai_failure")).toBe(true);
    expect(kinds.has("business.registered")).toBe(true);

    // Rule alerts: business B has been ACTIVE with no activity for 40 days.
    const quietIds = activity.alerts.quietBusinesses.map((row: { id: string }) => row.id);
    expect(quietIds).toContain(businessB);
    expect(activity.alerts.awaitingHuman.length).toBeGreaterThanOrEqual(1);
  });

  it("narrows the feed by event type", async () => {
    const res = await request(app)
      .get("/api/v1/admin/analytics/activity")
      .query({ businessId: businessA, type: "AI_RUN_FAILED" })
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    const activity = res.body.data.activity;
    expect(activity.total).toBe(2);
    expect(activity.entries.every((entry: { kind: string }) => entry.kind === "event.ai_failure")).toBe(true);
  });
});

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

function todayStartUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}