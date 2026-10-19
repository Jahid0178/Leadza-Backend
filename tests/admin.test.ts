import bcrypt from "bcryptjs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedAdmin } from "../prisma/seed";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { prisma } from "../src/lib/prisma";
import { findConversationBusinessState } from "../src/repositories/conversation.repository";
import { setPlatformRole } from "../src/services/admin.service";
import type { AdminUserDetailDto } from "../src/validation/admin.schemas";

/**
 * Platform admin area + audit trail (FEATURES §40–43, §45;
 * IMPLEMENTATION_PLAN steps 28–29).
 *
 * The suite pins the properties that make the area trustworthy:
 *   - a normal user reaches nothing, at any route (§60);
 *   - suspending a business actually takes it out of service, everywhere;
 *   - role changes and suspensions take effect immediately, not when the
 *     30-day session cookie expires;
 *   - an operator cannot lock the platform out of itself;
 *   - the audit trail records every sensitive action and has no write path.
 */

// The AI queue is the only place that calls the model; the suspension guard is
// observed by watching this mock instead of waiting for a real provider.
const runLeadAgentMock = vi.hoisted(() =>
  vi.fn(async () => ({ status: "skipped" as const, reason: "provider_disabled" })),
);
vi.mock("../src/agents/lead-agent", () => ({ runLeadAgent: runLeadAgentMock }));

import {
  drainAiReplyQueue,
  enqueueAiReply,
  startAiReplyQueue,
  stopAiReplyQueue,
} from "../src/jobs/ai-reply-queue";

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

async function loginActor(actor: Actor): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: actor.email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return sessionCookieFrom(res);
}

let admin: Actor;
let admin2: Actor;
let ownerA: Actor;
let ownerB: Actor;

let businessA: string;
let businessB: string;
let customerA: string;
let conversationA: string;
let conversationB: string;
let bookingA: string;

const businessAName = `Admin Test Plumbing ${stamp}`;
const businessBName = `Admin Test Heating ${stamp}`;

// Billing fixture ids: unique per run, deleted again in `afterAll` below.
const billingCustomerId = `ctm_admin_test_${stamp}`;
const billingSubscriptionId = `sub_admin_test_${stamp}`;
const billingEmail = `billing-${stamp}@example.com`;

beforeAll(async () => {
  [admin, admin2, ownerA, ownerB] = await Promise.all([
    registerActor("padmin"),
    registerActor("padmin2"),
    registerActor("aowner"),
    registerActor("bowner"),
  ]);

  const a = await prisma.business.create({
    data: {
      name: businessAName,
      type: "Plumbing",
      email: `biz-a-${stamp}@example.com`,
      phone: "01112223333",
    },
  });
  const b = await prisma.business.create({
    data: { name: businessBName, type: "Heating", email: `biz-b-${stamp}@example.com` },
  });
  businessA = a.id;
  businessB = b.id;

  await prisma.businessMember.createMany({
    data: [
      { businessId: businessA, userId: ownerA.userId, role: "OWNER" },
      { businessId: businessB, userId: ownerB.userId, role: "OWNER" },
    ],
  });

  // One of each countable record, so the §42 counts are exact rather than
  // "greater than zero".
  const customer = await prisma.customer.create({
    data: {
      businessId: businessA,
      name: `Admin Test Customer ${stamp}`,
      phone: "07000000001",
      email: `customer-${stamp}@example.com`,
    },
  });
  customerA = customer.id;

  await prisma.lead.create({
    data: {
      businessId: businessA,
      customerId: customerA,
      status: "QUALIFIED",
      urgency: "HIGH",
      customerMessage: "Please quote for a bathroom refit.",
    },
  });

  const threadA = await prisma.conversation.create({
    data: { businessId: businessA, customerId: customerA, status: "AI_ACTIVE" },
  });
  conversationA = threadA.id;
  await prisma.message.create({
    data: {
      conversationId: conversationA,
      sender: "AI",
      content: "Thanks — what day suits you?",
      aiGenerated: true,
    },
  });

  const threadB = await prisma.conversation.create({
    data: { businessId: businessB, customerId: (await prisma.customer.create({
      data: { businessId: businessB, name: `Admin Test Customer B ${stamp}` },
    })).id },
  });
  conversationB = threadB.id;

  const booking = await prisma.booking.create({
    data: {
      businessId: businessA,
      customerId: customerA,
      startAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      endAt: new Date(Date.now() + 25 * 60 * 60 * 1000),
      status: "CONFIRMED",
      origin: "STAFF",
    },
  });
  bookingA = booking.id;

  // Promote with raw SQL, then sign in again so the fixture cookie is honest;
  // the "takes effect immediately" behaviour is exercised on `admin2` instead.
  await prisma.user.update({
    where: { id: admin.userId },
    data: { platformRole: "PLATFORM_ADMIN" },
  });
  admin.cookie = await loginActor(admin);
}, 60000);

afterAll(async () => {
  const userIds = [admin, admin2, ownerA, ownerB].map((actor) => actor.userId);

  // Audit rows have no foreign keys on purpose (§45) — they must be cleaned up
  // explicitly, or every run would leave history behind.
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { actorId: { in: userIds } },
        { businessId: { in: [businessA, businessB] } },
        { resourceId: { in: userIds } },
      ],
    },
  });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  // Billing mirrors created by this suite (never any real Paddle ids).
  await prisma.subscription.deleteMany({
    where: { subscriptionId: billingSubscriptionId },
  });
  await prisma.paddleCustomer.deleteMany({
    where: { customerId: billingCustomerId },
  });

  await prisma.business.deleteMany({ where: { id: { in: [businessA, businessB] } } });
  stopAiReplyQueue();
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function patchBusinessStatus(businessId: string, status: string, cookie = admin.cookie) {
  return request(app)
    .patch(`/api/v1/admin/businesses/${businessId}/status`)
    .set("Cookie", cookie)
    .send({ status });
}

async function patchUserStatus(userId: string, status: string, cookie = admin.cookie) {
  return request(app)
    .patch(`/api/v1/admin/users/${userId}/status`)
    .set("Cookie", cookie)
    .send({ status });
}

async function patchPlatformRole(userId: string, platformRole: string, cookie = admin.cookie) {
  return request(app)
    .patch(`/api/v1/admin/users/${userId}/platform-role`)
    .set("Cookie", cookie)
    .send({ platformRole });
}

function latestAudit(action: string, resourceId: string) {
  return prisma.auditLog.findFirst({
    where: { action, resourceId },
    orderBy: { createdAt: "desc" },
  });
}

/* ------------------------------------------------------------------ *
 * §60 — the gate
 * ------------------------------------------------------------------ */

describe("admin gate (§5, §60)", () => {
  const routes: Array<[string, string]> = [
    ["get", "/api/v1/admin/overview"],
    ["get", "/api/v1/admin/businesses"],
    ["get", "/api/v1/admin/users"],
    ["get", "/api/v1/admin/audit-logs"],
    ["get", "/api/v1/admin/subscriptions"],
  ];

  it("rejects anonymous callers with 401", async () => {
    for (const [method, path] of routes) {
      const res = await (method === "get" ? request(app).get(path) : request(app).post(path));
      expect(res.status, path).toBe(401);
      expect(res.body.error.code, path).toBe("UNAUTHENTICATED");
    }
  });

  it("rejects a signed-in regular user with 403 on every admin route", async () => {
    for (const [method, path] of routes) {
      const res = await request(app)[method as "get"](path).set("Cookie", ownerA.cookie);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code, path).toBe("PLATFORM_ADMIN_REQUIRED");
    }

    // Mutating routes too — a suspended business is not a way in either.
    const mutate = await patchBusinessStatus(businessB, "SUSPENDED", ownerA.cookie);
    expect(mutate.status).toBe(403);
    expect(mutate.body.error.code).toBe("PLATFORM_ADMIN_REQUIRED");

    const mutateUser = await patchUserStatus(ownerB.userId, "SUSPENDED", ownerA.cookie);
    expect(mutateUser.status).toBe(403);

    const mutateRole = await patchPlatformRole(ownerB.userId, "PLATFORM_ADMIN", ownerA.cookie);
    expect(mutateRole.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ *
 * §41 — overview
 * ------------------------------------------------------------------ */

describe("platform overview (§41)", () => {
  it("reports the headline numbers and leaves Phase H fields null", async () => {
    const res = await request(app).get("/api/v1/admin/overview").set("Cookie", admin.cookie);
    expect(res.status).toBe(200);

    const overview = res.body.data.overview;
    expect(overview.businesses.total).toBeGreaterThanOrEqual(2);
    expect(overview.businesses.active).toBeGreaterThanOrEqual(1);
    expect(overview.users.total).toBeGreaterThanOrEqual(4);
    expect(overview.leadsToday).toBeGreaterThanOrEqual(1);
    expect(overview.qualifiedLeads).toBeGreaterThanOrEqual(1);
    expect(overview.bookings).toBeGreaterThanOrEqual(1);
    expect(overview.aiConversations).toBeGreaterThanOrEqual(1);

    // Steps 30–32 own these — a placeholder must never read as a real zero.
    expect(overview.aiUsage).toBeNull();
    expect(overview.estimatedAiCost).toBeNull();
    expect(overview.mrr).toBeNull();
  });

  it("counts a business as suspended only while it is suspended", async () => {
    const before = await request(app).get("/api/v1/admin/overview").set("Cookie", admin.cookie);

    await patchBusinessStatus(businessB, "SUSPENDED");
    const during = await request(app).get("/api/v1/admin/overview").set("Cookie", admin.cookie);
    expect(during.body.data.overview.businesses.suspended).toBe(
      before.body.data.overview.businesses.suspended + 1,
    );
    expect(during.body.data.overview.businesses.active).toBe(
      before.body.data.overview.businesses.active - 1,
    );

    await patchBusinessStatus(businessB, "ACTIVE");
    const after = await request(app).get("/api/v1/admin/overview").set("Cookie", admin.cookie);
    expect(after.body.data.overview.businesses).toEqual(before.body.data.overview.businesses);
  });

  it("counts a lead created today", async () => {
    const before = await request(app).get("/api/v1/admin/overview").set("Cookie", admin.cookie);

    const lead = await prisma.lead.create({
      data: { businessId: businessA, customerId: customerA, status: "NEW" },
    });
    const during = await request(app).get("/api/v1/admin/overview").set("Cookie", admin.cookie);
    expect(during.body.data.overview.leadsToday).toBe(
      before.body.data.overview.leadsToday + 1,
    );

    await prisma.lead.delete({ where: { id: lead.id } });
  });
});

/* ------------------------------------------------------------------ *
 * §42 — businesses
 * ------------------------------------------------------------------ */

describe("platform business management (§42)", () => {
  it("lists businesses across tenants, with pagination and counts", async () => {
    const res = await request(app)
      .get("/api/v1/admin/businesses?pageSize=100")
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(200);

    const ids = res.body.data.businesses.map((business: { id: string }) => business.id);
    // Cross-tenant on purpose: this is the platform view, not a tenant view.
    expect(ids).toContain(businessA);
    expect(ids).toContain(businessB);
    expect(res.body.data.total).toBeGreaterThanOrEqual(2);
    expect(res.body.data.page).toBe(1);
    expect(res.body.data.pageSize).toBe(100);

    const row = res.body.data.businesses.find(
      (business: { id: string }) => business.id === businessA,
    );
    expect(row).toMatchObject({
      name: businessAName,
      status: "ACTIVE",
      counts: { members: 1, customers: 1, leads: 1, conversations: 1, bookings: 1 },
    });
    expect(row.owners).toEqual([
      expect.objectContaining({ id: ownerA.userId, email: ownerA.email, role: "OWNER" }),
    ]);
  });

  it("searches by name and filters by status", async () => {
    const byName = await request(app)
      .get(`/api/v1/admin/businesses?search=${encodeURIComponent(businessAName)}`)
      .set("Cookie", admin.cookie);
    expect(
      byName.body.data.businesses.map((b: { id: string }) => b.id),
    ).toEqual([businessA]);

    await patchBusinessStatus(businessB, "SUSPENDED");
    const suspended = await request(app)
      .get("/api/v1/admin/businesses?status=SUSPENDED&pageSize=100")
      .set("Cookie", admin.cookie);
    const ids = suspended.body.data.businesses.map((b: { id: string }) => b.id);
    expect(ids).toContain(businessB);
    expect(ids).not.toContain(businessA);

    await patchBusinessStatus(businessB, "ACTIVE");
  });

  it("returns a business detail with members and its audit trail", async () => {
    const res = await request(app)
      .get(`/api/v1/admin/businesses/${businessA}`)
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(200);

    const business = res.body.data.business;
    expect(business.id).toBe(businessA);
    expect(business.members).toHaveLength(1);
    expect(business.members[0]).toMatchObject({ email: ownerA.email, role: "OWNER" });
    expect(business.recentAudit).toEqual([]);
    expect(JSON.stringify(business)).not.toContain("passwordHash");
  });

  it("answers 404 for an unknown business", async () => {
    const res = await request(app)
      .get("/api/v1/admin/businesses/does-not-exist")
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("suspends and restores a business, auditing both actions", async () => {
    const suspended = await patchBusinessStatus(businessB, "SUSPENDED");
    expect(suspended.status).toBe(200);
    expect(suspended.body.data.business.status).toBe("SUSPENDED");
    expect(suspended.body.data.changed).toBe(true);
    expect(suspended.body.data.previousStatus).toBe("ACTIVE");

    const suspendEntry = await latestAudit("business.suspended", businessB);
    expect(suspendEntry).toMatchObject({
      actorId: admin.userId,
      actorEmail: admin.email,
      resourceType: "business",
      resourceId: businessB,
      businessId: businessB,
      metadata: { from: "ACTIVE", to: "SUSPENDED" },
    });

    const restored = await patchBusinessStatus(businessB, "ACTIVE");
    expect(restored.body.data.business.status).toBe("ACTIVE");
    expect(restored.body.data.previousStatus).toBe("SUSPENDED");

    const restoreEntry = await latestAudit("business.restored", businessB);
    expect(restoreEntry).toMatchObject({
      actorId: admin.userId,
      action: "business.restored",
      metadata: { from: "SUSPENDED", to: "ACTIVE" },
    });
  });

  it("treats re-sending the current status as a no-op that logs nothing", async () => {
    const before = await prisma.auditLog.count({ where: { businessId: businessA } });

    const res = await patchBusinessStatus(businessA, "ACTIVE");
    expect(res.status).toBe(200);
    expect(res.body.data.changed).toBe(false);
    expect(res.body.data.previousStatus).toBe("ACTIVE");

    expect(await prisma.auditLog.count({ where: { businessId: businessA } })).toBe(before);
  });

  it("rejects an unknown status with 400", async () => {
    const res = await patchBusinessStatus(businessA, "DELETED");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

/* ------------------------------------------------------------------ *
 * Suspension really suspends (§42–43)
 * ------------------------------------------------------------------ */

describe("a suspended business is out of service (§42)", () => {
  it("refuses the tenant's own API while keeping the status readable", async () => {
    await patchBusinessStatus(businessB, "SUSPENDED");

    // The list stays readable so the dashboard can explain what happened…
    const list = await request(app).get("/api/v1/businesses").set("Cookie", ownerB.cookie);
    expect(list.status).toBe(200);
    expect(list.body.data.businesses[0]).toMatchObject({
      id: businessB,
      status: "SUSPENDED",
    });

    // …but nothing else answers.
    const detail = await request(app)
      .get(`/api/v1/businesses/${businessB}`)
      .set("Cookie", ownerB.cookie);
    expect(detail.status).toBe(403);
    expect(detail.body.error.code).toBe("BUSINESS_SUSPENDED");

    const write = await request(app)
      .patch(`/api/v1/businesses/${businessB}`)
      .set("Cookie", ownerB.cookie)
      .send({ name: "Hijacked while suspended" });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe("BUSINESS_SUSPENDED");

    const leads = await request(app)
      .get(`/api/v1/leads?businessId=${businessB}`)
      .set("Cookie", ownerB.cookie);
    expect(leads.status).toBe(403);
    expect(leads.body.error.code).toBe("BUSINESS_SUSPENDED");

    const bookings = await request(app)
      .get(`/api/v1/bookings?businessId=${businessB}`)
      .set("Cookie", ownerB.cookie);
    expect(bookings.status).toBe(403);
    expect(bookings.body.error.code).toBe("BUSINESS_SUSPENDED");

    // Anonymous public capture is refused too (the pre-existing rule).
    const publicCapture = await request(app)
      .post(`/api/v1/leads/public/${businessB}`)
      .send({ name: "Visitor", phone: "07700 900777", message: "Still there?" });
    expect(publicCapture.status).toBe(403);
    expect(publicCapture.body.error.code).toBe("BUSINESS_SUSPENDED");

    await patchBusinessStatus(businessB, "ACTIVE");

    // …and the tenant works again once restored.
    const restored = await request(app)
      .get(`/api/v1/businesses/${businessB}`)
      .set("Cookie", ownerB.cookie);
    expect(restored.status).toBe(200);
  });

  it("reports the suspension to the AI queue instead of answering", async () => {
    const active = await findConversationBusinessState(conversationA);
    expect(active).toEqual({ businessId: businessA, status: "ACTIVE" });

    await patchBusinessStatus(businessB, "SUSPENDED");
    const suspended = await findConversationBusinessState(conversationB);
    expect(suspended).toEqual({ businessId: businessB, status: "SUSPENDED" });

    startAiReplyQueue();
    runLeadAgentMock.mockClear();

    enqueueAiReply(conversationB);
    await drainAiReplyQueue();
    expect(runLeadAgentMock).not.toHaveBeenCalled();

    enqueueAiReply(conversationA);
    await drainAiReplyQueue();
    expect(runLeadAgentMock).toHaveBeenCalledTimes(1);

    stopAiReplyQueue();
    await patchBusinessStatus(businessB, "ACTIVE");
  });
});

/* ------------------------------------------------------------------ *
 * §43 — users
 * ------------------------------------------------------------------ */

describe("platform user management (§43)", () => {
  it("lists and searches users without ever exposing a password hash", async () => {
    const res = await request(app)
      .get(`/api/v1/admin/users?search=${encodeURIComponent(ownerA.email)}`)
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.users).toHaveLength(1);
    expect(res.body.data.users[0]).toMatchObject({
      id: ownerA.userId,
      email: ownerA.email,
      platformRole: "USER",
      status: "ACTIVE",
    });
    expect(res.body.data.users[0].memberships).toEqual([
      expect.objectContaining({
        businessId: businessA,
        businessName: businessAName,
        role: "OWNER",
      }),
    ]);
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
  });

  it("filters by platform role and by business", async () => {
    const admins = await request(app)
      .get("/api/v1/admin/users?role=PLATFORM_ADMIN&pageSize=100")
      .set("Cookie", admin.cookie);
    const adminIds = admins.body.data.users.map((user: { id: string }) => user.id);
    expect(adminIds).toContain(admin.userId);
    expect(adminIds).not.toContain(ownerA.userId);

    const members = await request(app)
      .get(`/api/v1/admin/users?businessId=${businessA}`)
      .set("Cookie", admin.cookie);
    expect(members.body.data.users.map((user: { id: string }) => user.id)).toEqual([
      ownerA.userId,
    ]);
  });

  it("returns a user detail with memberships and activity counts", async () => {
    const res = await request(app)
      .get(`/api/v1/admin/users/${ownerA.userId}`)
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({
      id: ownerA.userId,
      counts: { createdBookings: 0, assignedConversations: 0 },
    });
    expect(res.body.data.user.memberships).toHaveLength(1);

    const missing = await request(app)
      .get("/api/v1/admin/users/does-not-exist")
      .set("Cookie", admin.cookie);
    expect(missing.status).toBe(404);
  });

  it("suspends a user, which ends their ability to sign in, and restores them", async () => {
    const suspended = await patchUserStatus(ownerB.userId, "SUSPENDED");
    expect(suspended.status).toBe(200);
    expect(suspended.body.data.user.status).toBe("SUSPENDED");
    expect(suspended.body.data.changed).toBe(true);

    const entry = await latestAudit("user.suspended", ownerB.userId);
    expect(entry).toMatchObject({
      actorId: admin.userId,
      resourceType: "user",
      resourceId: ownerB.userId,
      businessId: null,
      metadata: { from: "ACTIVE", to: "SUSPENDED" },
    });

    const denied = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: ownerB.email, password });
    expect(denied.status).toBe(401);
    expect(denied.body.error.code).toBe("INVALID_CREDENTIALS");

    const restored = await patchUserStatus(ownerB.userId, "ACTIVE");
    expect(restored.body.data.user.status).toBe("ACTIVE");
    expect(await latestAudit("user.restored", ownerB.userId)).toMatchObject({
      actorId: admin.userId,
    });

    const allowed = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: ownerB.email, password });
    expect(allowed.status).toBe(200);
  });

  it("refuses to let an administrator suspend their own account", async () => {
    const res = await patchUserStatus(admin.userId, "SUSPENDED");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("SELF_SUSPEND_NOT_ALLOWED");
  });

  it("refuses to let an administrator remove their own platform access", async () => {
    const res = await patchPlatformRole(admin.userId, "USER");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("SELF_DEMOTION_NOT_ALLOWED");
  });

  it("applies a granted role immediately, and a revoked one immediately too", async () => {
    // admin2's cookie was issued while the account was a regular USER.
    const before = await request(app)
      .get("/api/v1/admin/status")
      .set("Cookie", admin2.cookie);
    expect(before.status).toBe(403);

    const granted = await patchPlatformRole(admin2.userId, "PLATFORM_ADMIN");
    expect(granted.status).toBe(200);
    expect(granted.body.data.changed).toBe(true);
    expect(granted.body.data.previousRole).toBe("USER");

    const entry = await latestAudit("user.platform_role_changed", admin2.userId);
    expect(entry).toMatchObject({
      actorId: admin.userId,
      metadata: { from: "USER", to: "PLATFORM_ADMIN" },
    });

    // No re-login: the same 30-day cookie now reaches the admin API, because
    // the gate reads the account rather than the token.
    const allowed = await request(app)
      .get("/api/v1/admin/status")
      .set("Cookie", admin2.cookie);
    expect(allowed.status).toBe(200);

    // The session endpoint agrees, so the UI gate matches the API.
    const session = await request(app)
      .get("/api/v1/auth/session")
      .set("Cookie", admin2.cookie);
    expect(session.body.data.user.platformRole).toBe("PLATFORM_ADMIN");

    const revoked = await patchPlatformRole(admin2.userId, "USER");
    expect(revoked.body.data.user.platformRole).toBe("USER");

    const denied = await request(app)
      .get("/api/v1/admin/status")
      .set("Cookie", admin2.cookie);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("PLATFORM_ADMIN_REQUIRED");
  });

  it("refuses to serve a suspended administrator", async () => {
    // A suspended administrator cannot use the admin API at all.
    await patchPlatformRole(admin2.userId, "PLATFORM_ADMIN");
    await patchUserStatus(admin2.userId, "SUSPENDED");

    const res = await request(app)
      .get("/api/v1/admin/status")
      .set("Cookie", admin2.cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCOUNT_SUSPENDED");

    await patchUserStatus(admin2.userId, "ACTIVE");
    await patchPlatformRole(admin2.userId, "USER");
  });
});

describe("platform role rules (unit)", () => {
  const actor = { id: "actor-1", email: "actor@example.com" };
  const target = (overrides: Partial<AdminUserDetailDto>) =>
    ({
      id: "target-1",
      platformRole: "PLATFORM_ADMIN",
      status: "ACTIVE",
      ...overrides,
    }) as AdminUserDetailDto;

  it("refuses to demote the last active administrator", async () => {
    await expect(
      setPlatformRole(actor, "target-1", "USER", {
        findUserForAdmin: async () => target({}),
        countActivePlatformAdmins: async () => 1,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "LAST_PLATFORM_ADMIN" });
  });

  it("allows the demotion when another active administrator remains", async () => {
    // The guard passes and the repository takes over — an unknown id proves we
    // reached it rather than throwing earlier.
    const result = await setPlatformRole(actor, `missing-${stamp}`, "USER", {
      findUserForAdmin: async () => target({}),
      countActivePlatformAdmins: async () => 2,
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("does not count a suspended administrator as cover", async () => {
    const result = await setPlatformRole(actor, `missing-${stamp}`, "USER", {
      findUserForAdmin: async () => target({ status: "SUSPENDED" }),
      countActivePlatformAdmins: async () => 1,
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

/* ------------------------------------------------------------------ *
 * Phase H — billing subscriptions
 * ------------------------------------------------------------------ */

describe("platform billing (Phase H)", () => {
  const billedPriceId = "pri_01m5ath3h8q9njyqr2w38kedr0";
  const billedProductId = "pro_01m5ath34z1berzctwc08rd6v6";

  beforeAll(async () => {
    await prisma.paddleCustomer.upsert({
      where: { customerId: billingCustomerId },
      create: { customerId: billingCustomerId, email: billingEmail, businessId: businessA },
      update: {},
    });

    await prisma.subscription.upsert({
      where: { subscriptionId: billingSubscriptionId },
      create: {
        subscriptionId: billingSubscriptionId,
        customerId: billingCustomerId,
        businessId: businessA,
        status: "trialing",
        priceId: billedPriceId,
        productId: billedProductId,
        paddleCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
        nextBilledAt: new Date("2026-01-08T00:00:00.000Z"),
      },
      update: {},
    });
  });

  it("lists every subscription with its tenant, plan ids and status", async () => {
    const res = await request(app)
      .get("/api/v1/admin/subscriptions")
      .set("Cookie", admin.cookie);

    expect(res.status).toBe(200);

    const listed = (
      res.body.data.subscriptions as Array<Record<string, unknown>>
    ).find((row) => row.subscriptionId === billingSubscriptionId);

    expect(listed).toMatchObject({
      status: "trialing",
      priceId: billedPriceId,
      productId: billedProductId,
      business: { id: businessA, name: businessAName },
      customer: { customerId: billingCustomerId, email: billingEmail },
    });

    // The summary is platform-wide, so it can never shrink below one row.
    expect(res.body.data.summary.trialing).toBeGreaterThanOrEqual(1);
    expect(res.body.data.summary.total).toBeGreaterThanOrEqual(1);
  });

  it("filters by status and searches business, email or subscription id", async () => {
    const byEmail = await request(app)
      .get(`/api/v1/admin/subscriptions?search=${encodeURIComponent(billingEmail)}`)
      .set("Cookie", admin.cookie);
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.data.total).toBe(1);

    const bySubscription = await request(app)
      .get(`/api/v1/admin/subscriptions?search=${billingSubscriptionId}`)
      .set("Cookie", admin.cookie);
    expect(bySubscription.body.data.total).toBe(1);

    const byName = await request(app)
      .get(`/api/v1/admin/subscriptions?search=${encodeURIComponent(businessAName)}`)
      .set("Cookie", admin.cookie);
    expect(byName.body.data.total).toBeGreaterThanOrEqual(1);

    const canceled = await request(app)
      .get("/api/v1/admin/subscriptions?status=canceled")
      .set("Cookie", admin.cookie);
    expect(canceled.status).toBe(200);
    expect(
      (canceled.body.data.subscriptions as Array<{ status: string }>).every(
        (row) => row.status === "canceled",
      ),
    ).toBe(true);
  });

  it("rejects an unknown status with 400", async () => {
    const res = await request(app)
      .get("/api/v1/admin/subscriptions?status=refunded")
      .set("Cookie", admin.cookie);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("never exposes billing secrets", async () => {
    const res = await request(app)
      .get("/api/v1/admin/subscriptions")
      .set("Cookie", admin.cookie);

    const body = JSON.stringify(res.body);
    for (const secret of [
      env.PADDLE_SANDBOX_API_KEY,
      env.PADDLE_WEBHOOK_SANDBOX_SECRET,
    ]) {
      if (secret) expect(body).not.toContain(secret);
    }
  });
});

/* ------------------------------------------------------------------ *
 * §45 — audit logs
 * ------------------------------------------------------------------ */

describe("audit logs (§45)", () => {
  it("reads back the actions, newest first, with filters", async () => {
    await patchBusinessStatus(businessA, "ACTIVE");
    await patchBusinessStatus(businessA, "SUSPENDED");

    const res = await request(app)
      .get(`/api/v1/admin/audit-logs?businessId=${businessA}`)
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBeGreaterThanOrEqual(1);

    const latest = res.body.data.logs[0];
    expect(latest).toMatchObject({
      action: "business.suspended",
      resourceType: "business",
      resourceId: businessA,
      businessId: businessA,
      actorId: admin.userId,
      actorEmail: admin.email,
      metadata: { from: "ACTIVE", to: "SUSPENDED" },
    });

    const byAction = await request(app)
      .get("/api/v1/admin/audit-logs?action=user.platform_role_changed&pageSize=100")
      .set("Cookie", admin.cookie);
    expect(
      byAction.body.data.logs.every(
        (log: { action: string }) => log.action === "user.platform_role_changed",
      ),
    ).toBe(true);

    const byActor = await request(app)
      .get(`/api/v1/admin/audit-logs?actorId=${admin.userId}&pageSize=100`)
      .set("Cookie", admin.cookie);
    expect(
      byActor.body.data.logs.every((log: { actorId: string }) => log.actorId === admin.userId),
    ).toBe(true);

    await patchBusinessStatus(businessA, "ACTIVE");
  });

  it("is append-only: no request can create, change or delete an entry", async () => {
    const before = await prisma.auditLog.count();

    for (const method of ["post", "patch", "delete"] as const) {
      const res = await request(app)
        [method]("/api/v1/admin/audit-logs")
        .set("Cookie", admin.cookie)
        .send({ action: "business.suspended", resourceId: businessA });
      expect(res.status, method).toBe(404);
      expect(res.body.error.code, method).toBe("NOT_FOUND");
    }

    expect(await prisma.auditLog.count()).toBe(before);
  });

  it("cannot be written from a business-scoped route", async () => {
    const before = await prisma.auditLog.count({ where: { businessId: businessA } });

    const write = await request(app)
      .patch(`/api/v1/businesses/${businessA}`)
      .set("Cookie", ownerA.cookie)
      .send({ name: `${businessAName} renamed` });
    expect(write.status).toBe(200);

    expect(await prisma.auditLog.count({ where: { businessId: businessA } })).toBe(before);
  });

  it("rejects an unknown action filter with 400", async () => {
    const res = await request(app)
      .get("/api/v1/admin/audit-logs?action=business.deleted")
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

/* ------------------------------------------------------------------ *
 * Seed (step 28)
 * ------------------------------------------------------------------ */

describe("seed: the default platform administrator (step 28)", () => {
  const seedEmail = `seed-admin-${stamp}@example.com`;

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: { in: [seedEmail, `prod-admin-${stamp}@example.com`, `short-${stamp}@example.com`] } },
    });
  });

  it("creates an active, verified administrator", async () => {
    const result = await seedAdmin({ email: seedEmail, password: "seed-pass-1" });
    expect(result).toEqual({ email: seedEmail, created: true });

    const user = await prisma.user.findUniqueOrThrow({ where: { email: seedEmail } });
    expect(user.platformRole).toBe("PLATFORM_ADMIN");
    expect(user.status).toBe("ACTIVE");
    expect(user.emailVerified).not.toBeNull();
    expect(await bcrypt.compare("seed-pass-1", user.passwordHash)).toBe(true);
  });

  it("is idempotent and never rewrites an existing password", async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { email: seedEmail } });

    const second = await seedAdmin({ email: seedEmail, password: "a-different-pass-2" });
    expect(second).toEqual({ email: seedEmail, created: false });

    const after = await prisma.user.findUniqueOrThrow({ where: { email: seedEmail } });
    expect(after.id).toBe(before.id);
    expect(after.platformRole).toBe("PLATFORM_ADMIN");
    // A rotated credential must survive a re-seed: the old password still works
    // and the one the operator typed into the command line does not.
    expect(await bcrypt.compare("seed-pass-1", after.passwordHash)).toBe(true);
    expect(await bcrypt.compare("a-different-pass-2", after.passwordHash)).toBe(false);
  });

  it("refuses the development default password in production", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousPassword = process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PASSWORD;
    process.env.NODE_ENV = "production";

    const prodEmail = `prod-admin-${stamp}@example.com`;
    try {
      await expect(seedAdmin({ email: prodEmail })).rejects.toThrow(/ADMIN_PASSWORD/);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (previousPassword === undefined) delete process.env.ADMIN_PASSWORD;
      else process.env.ADMIN_PASSWORD = previousPassword;
    }

    expect(await prisma.user.findUnique({ where: { email: prodEmail } })).toBeNull();
  });

  it("rejects a password that is too short", async () => {
    await expect(
      seedAdmin({ email: `short-${stamp}@example.com`, password: "short" }),
    ).rejects.toThrow(/at least 8 characters/);
  });
});
