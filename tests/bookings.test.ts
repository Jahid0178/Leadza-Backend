import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { grantPlan } from "./helpers/plan";

/**
 * Booking API tests (FEATURES §34–35, IMPLEMENTATION_PLAN step 27, agent.md §19).
 *
 * Two tenants: business A has opening hours and is used for the happy paths;
 * business B has none, so it proves "no source of availability → no slots".
 * The permission matrix and the double-booking guard are the point: a slot is
 * only ever held by one active booking.
 */

const app = createApp();

const stamp = Date.now();
const password = "s3cure-pass-1";
const ALL_WEEKDAYS = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;

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

let owner: Actor;
let staff: Actor;
let outsider: Actor;
let businessA: string;
let businessB: string;
let customerA: string;
let customerB: string;
let serviceA: string;

/** London wall-clock "HH:MM" for an ISO instant. */
function londonTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

interface Slot {
  startAt: string;
  endAt: string;
}

/** Free slots for businessA over the next `days` days. */
async function availability(actor: Actor, days = 21): Promise<Slot[]> {
  const from = new Date();
  const to = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  const res = await request(app)
    .get("/api/v1/bookings/availability")
    .set("Cookie", actor.cookie)
    .query({ businessId: businessA, from: from.toISOString(), to: to.toISOString() });
  if (res.status !== 200) {
    throw new Error(`availability failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.slots as Slot[];
}

async function createBooking(actor: Actor, body: Record<string, unknown>) {
  return request(app).post("/api/v1/bookings").set("Cookie", actor.cookie).send(body);
}

beforeAll(async () => {
  [owner, staff, outsider] = await Promise.all([
    registerActor("bowner"),
    registerActor("bstaff"),
    registerActor("bout"),
  ]);

  const created = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", owner.cookie)
    .send({ name: "Booking Test Plumbing", type: "Plumber" });
  businessA = created.body.data.business.id as string;

  // Booking writes are metered (step 31): give business A a plan that includes
  // appointments. The no-subscription refusal is covered in usage.test.ts.
  await grantPlan(businessA, "pro");

  const foreign = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", outsider.cookie)
    .send({ name: "Booking Foreign Heating", type: "Heating" });
  businessB = foreign.body.data.business.id as string;

  // Business B also has a plan, so its missing-hours refusal stays about the
  // hours rather than a subscription. It still has no opening hours.
  await grantPlan(businessB, "pro");

  await prisma.businessMember.create({
    data: { businessId: businessA, userId: staff.userId, role: "STAFF" },
  });

  // business A is open 09:00–17:00 every day; business B has no hours at all.
  await prisma.businessHour.createMany({
    data: ALL_WEEKDAYS.map((weekday) => ({
      businessId: businessA,
      weekday,
      startTime: "09:00",
      endTime: "17:00",
    })),
  });

  const custA = await request(app)
    .post("/api/v1/customers")
    .set("Cookie", owner.cookie)
    .send({ businessId: businessA, name: "Booking Fixture", phone: "07700 900333" });
  customerA = custA.body.data.customer.id as string;

  const custB = await request(app)
    .post("/api/v1/customers")
    .set("Cookie", outsider.cookie)
    .send({ businessId: businessB, name: "Foreign Fixture", phone: "07700 900444" });
  customerB = custB.body.data.customer.id as string;

  const service = await request(app)
    .post("/api/v1/services")
    .set("Cookie", owner.cookie)
    .send({ businessId: businessA, name: "Boiler Repair", price: 90, priceType: "FROM", duration: 60 });
  serviceA = service.body.data.service.id as string;
});

afterAll(async () => {
  await prisma.user.deleteMany({
    where: { id: { in: [owner.userId, staff.userId, outsider.userId] } },
  });
  await prisma.business.deleteMany({
    where: { name: { in: ["Booking Test Plumbing", "Booking Foreign Heating"] } },
  });
});

describe("availability (§35)", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/v1/bookings/availability");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("generates slots inside the configured opening hours", async () => {
    const slots = await availability(owner);
    expect(slots.length).toBeGreaterThan(0);

    for (const slot of slots) {
      const [hour, minute] = londonTime(slot.startAt).split(":").map(Number);
      const minutes = (hour ?? 0) * 60 + (minute ?? 0);
      expect(minutes).toBeGreaterThanOrEqual(9 * 60);
      expect(minutes).toBeLessThanOrEqual(16 * 60);
      expect(new Date(slot.endAt).getTime()).toBeGreaterThan(new Date(slot.startAt).getTime());
    }

    // Sorted ascending.
    const times = slots.map((slot) => new Date(slot.startAt).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("returns no slots when no hours are configured (§25)", async () => {
    const from = new Date();
    const to = new Date(from.getTime() + 10 * 24 * 60 * 60 * 1000);
    const res = await request(app)
      .get("/api/v1/bookings/availability")
      .set("Cookie", outsider.cookie)
      .query({ businessId: businessB, from: from.toISOString(), to: to.toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.data.slots).toEqual([]);
  });

  it("hides another business's availability (§13)", async () => {
    const from = new Date();
    const to = new Date(from.getTime() + 10 * 24 * 60 * 60 * 1000);
    const res = await request(app)
      .get("/api/v1/bookings/availability")
      .set("Cookie", owner.cookie)
      .query({ businessId: businessB, from: from.toISOString(), to: to.toISOString() });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

describe("creating bookings (§35)", () => {
  it("creates a CONFIRMED booking at a real slot", async () => {
    const slots = await availability(owner);
    const slot = slots[0] as Slot;

    const res = await createBooking(owner, {
      businessId: businessA,
      customerId: customerA,
      serviceId: serviceA,
      startAt: slot.startAt,
    });
    expect(res.status).toBe(201);
    const booking = res.body.data.booking;
    expect(booking.status).toBe("CONFIRMED");
    expect(booking.origin).toBe("STAFF");
    expect(booking.createdById).toBe(owner.userId);
    expect(booking.customer.name).toBe("Booking Fixture");
    expect(booking.service.name).toBe("Boiler Repair");
    expect(new Date(booking.endAt).getTime() - new Date(booking.startAt).getTime()).toBe(60 * 60 * 1000);
  });

  it("refuses to double-book the same slot (§35)", async () => {
    const slots = await availability(owner);
    const slot = slots[0] as Slot;

    const first = await createBooking(owner, {
      businessId: businessA,
      customerId: customerA,
      startAt: slot.startAt,
    });
    expect(first.status).toBe(201);

    const second = await createBooking(owner, {
      businessId: businessA,
      customerId: customerA,
      startAt: slot.startAt,
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("BOOKING_UNAVAILABLE");

    // The taken slot disappears from availability.
    const now = await availability(owner);
    expect(now.some((s) => s.startAt === slot.startAt)).toBe(false);
  });

  it("lets only one of two concurrent creates win the slot (§35)", async () => {
    const slots = await availability(owner);
    const slot = slots[10] as Slot;

    const [a, b] = await Promise.all([
      createBooking(owner, { businessId: businessA, customerId: customerA, startAt: slot.startAt }),
      createBooking(staff, { businessId: businessA, customerId: customerA, startAt: slot.startAt }),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([201, 409]);
  });

  it("lets STAFF create a booking (operational work)", async () => {
    const slots = await availability(staff);
    const res = await createBooking(staff, {
      businessId: businessA,
      customerId: customerA,
      startAt: (slots[20] as Slot).startAt,
    });
    expect(res.status).toBe(201);
  });

  it("rejects a customer from another business (§13)", async () => {
    const slots = await availability(owner);
    const res = await createBooking(owner, {
      businessId: businessA,
      customerId: customerB,
      startAt: (slots[30] as Slot).startAt,
    });
    expect(res.status).toBe(404);
  });

  it("rejects a business the caller is not a member of (§13)", async () => {
    const slots = await availability(owner);
    const res = await createBooking(owner, {
      businessId: businessB,
      customerId: customerB,
      startAt: (slots[40] as Slot).startAt,
    });
    expect(res.status).toBe(404);
  });

  it("refuses a slot outside the opening hours as BOOKING_OUTSIDE_HOURS (§35)", async () => {
    // Business B has no hours at all, so no time can be inside them.
    const res = await createBooking(outsider, {
      businessId: businessB,
      customerId: customerB,
      startAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BOOKING_OUTSIDE_HOURS");
    expect(res.body.error.message).toContain("none are set");
  });

  it("names the opening hours instead of calling the slot taken (§35)", async () => {
    const slots = await availability(owner);
    // Twelve hours after a legal slot is past closing whatever that slot's
    // time was, so the refusal is about the hours and not about a clash.
    const outside = new Date(new Date((slots[85] as Slot).startAt).getTime() + 12 * 60 * 60 * 1000);

    const res = await createBooking(owner, {
      businessId: businessA,
      customerId: customerA,
      startAt: outside.toISOString(),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BOOKING_OUTSIDE_HOURS");
    expect(res.body.error.message).toContain("09:00–17:00");
  });

  it("rejects a create whose end is before its start (§35)", async () => {
    const slots = await availability(owner);
    const slot = slots[100] as Slot;

    const res = await createBooking(owner, {
      businessId: businessA,
      customerId: customerA,
      startAt: slot.startAt,
      endAt: new Date(new Date(slot.startAt).getTime() - 60 * 60 * 1000).toISOString(),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("moves a QUALIFIED lead to BOOKED through the transition table (§19)", async () => {
    const lead = await prisma.lead.create({
      data: { businessId: businessA, customerId: customerA, status: "QUALIFIED" },
    });
    const slots = await availability(owner);
    const res = await createBooking(owner, {
      businessId: businessA,
      customerId: customerA,
      leadId: lead.id,
      startAt: (slots[45] as Slot).startAt,
    });
    expect(res.status).toBe(201);

    const reloaded = await prisma.lead.findUnique({ where: { id: lead.id } });
    expect(reloaded?.status).toBe("BOOKED");
  });

  it("never jumps a NEW lead straight to BOOKED (invalid transition is skipped)", async () => {
    const lead = await prisma.lead.create({
      data: { businessId: businessA, customerId: customerA },
    });
    const slots = await availability(owner);
    const res = await createBooking(owner, {
      businessId: businessA,
      customerId: customerA,
      leadId: lead.id,
      startAt: (slots[50] as Slot).startAt,
    });
    expect(res.status).toBe(201);

    const reloaded = await prisma.lead.findUnique({ where: { id: lead.id } });
    expect(reloaded?.status).toBe("NEW");
  });
});

describe("status transitions (§19)", () => {
  it("rejects a jump the table forbids, then allows a legal one", async () => {
    const slots = await availability(owner);
    const created = await createBooking(owner, {
      businessId: businessA,
      customerId: customerA,
      status: "PENDING",
      startAt: (slots[55] as Slot).startAt,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.booking.status).toBe("PENDING");
    const bookingId = created.body.data.booking.id as string;

    const jump = await request(app)
      .patch(`/api/v1/bookings/${bookingId}/status`)
      .set("Cookie", owner.cookie)
      .send({ status: "COMPLETED" });
    expect(jump.status).toBe(400);
    expect(jump.body.error.code).toBe("INVALID_TRANSITION");

    const confirm = await request(app)
      .patch(`/api/v1/bookings/${bookingId}/status`)
      .set("Cookie", owner.cookie)
      .send({ status: "CONFIRMED" });
    expect(confirm.status).toBe(200);
    expect(confirm.body.data.booking.status).toBe("CONFIRMED");
  });
});

describe("reschedule and cancel (§35)", () => {
  it("frees the old slot and takes the new one", async () => {
    const slots = await availability(owner);
    const original = slots[60] as Slot;
    const target = slots[65] as Slot;

    const created = await createBooking(owner, {
      businessId: businessA,
      customerId: customerA,
      startAt: original.startAt,
    });
    expect(created.status).toBe(201);
    const bookingId = created.body.data.booking.id as string;

    const moved = await request(app)
      .patch(`/api/v1/bookings/${bookingId}`)
      .set("Cookie", owner.cookie)
      .send({ startAt: target.startAt });
    expect(moved.status).toBe(200);
    expect(moved.body.data.booking.startAt).toBe(target.startAt);

    const now = await availability(owner);
    expect(now.some((s) => s.startAt === original.startAt)).toBe(true);
    expect(now.some((s) => s.startAt === target.startAt)).toBe(false);
  });

  it("rejects a reschedule onto an occupied slot (§35)", async () => {
    const slots = await availability(owner);
    const taken = slots[70] as Slot;
    const mine = slots[75] as Slot;

    await createBooking(owner, { businessId: businessA, customerId: customerA, startAt: taken.startAt });
    const created = await createBooking(owner, {
      businessId: businessA,
      customerId: customerA,
      startAt: mine.startAt,
    });
    const bookingId = created.body.data.booking.id as string;

    const moved = await request(app)
      .patch(`/api/v1/bookings/${bookingId}`)
      .set("Cookie", owner.cookie)
      .send({ startAt: taken.startAt });
    expect(moved.status).toBe(409);
    expect(moved.body.error.code).toBe("BOOKING_UNAVAILABLE");
  });

  it("does not report an edit past closing as a taken slot (§35)", async () => {
    const slots = await availability(owner);
    const slot = slots[90] as Slot;

    const created = await createBooking(owner, {
      businessId: businessA,
      customerId: customerA,
      startAt: slot.startAt,
    });
    expect(created.status).toBe(201);
    const bookingId = created.body.data.booking.id as string;

    // The bug this covers: the start is untouched and only the end runs past
    // closing, which used to come back as "no longer available" — reading like
    // a clash with the appointment itself, with nothing to act on.
    const stretched = new Date(new Date(slot.startAt).getTime() + 8 * 60 * 60 * 1000);
    const res = await request(app)
      .patch(`/api/v1/bookings/${bookingId}`)
      .set("Cookie", owner.cookie)
      .send({ startAt: slot.startAt, endAt: stretched.toISOString() });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BOOKING_OUTSIDE_HOURS");
    expect(res.body.error.message).not.toContain("no longer available");
    expect(res.body.error.message).toContain("09:00–17:00");

    // Nothing was written: the appointment still ends where it did.
    const stored = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(stored?.endAt.toISOString()).toBe(new Date(slot.endAt).toISOString());
  });

  it("refuses a backwards range instead of silently rewriting it (§35)", async () => {
    const slots = await availability(owner);
    const slot = slots[95] as Slot;

    const created = await createBooking(owner, {
      businessId: businessA,
      customerId: customerA,
      startAt: slot.startAt,
    });
    const bookingId = created.body.data.booking.id as string;
    const before = new Date(new Date(slot.startAt).getTime() - 60 * 60 * 1000).toISOString();

    const both = await request(app)
      .patch(`/api/v1/bookings/${bookingId}`)
      .set("Cookie", owner.cookie)
      .send({ startAt: slot.startAt, endAt: before });
    expect(both.status).toBe(400);
    expect(both.body.error.code).toBe("VALIDATION_ERROR");
    expect(both.body.error.message).toBe("The end time must be after the start time.");

    // An end on its own is judged against the stored start.
    const endOnly = await request(app)
      .patch(`/api/v1/bookings/${bookingId}`)
      .set("Cookie", owner.cookie)
      .send({ endAt: before });
    expect(endOnly.status).toBe(400);
    expect(endOnly.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("cancels a booking, records when, and frees the slot", async () => {
    const slots = await availability(owner);
    const slot = slots[80] as Slot;

    const created = await createBooking(owner, {
      businessId: businessA,
      customerId: customerA,
      startAt: slot.startAt,
    });
    const bookingId = created.body.data.booking.id as string;

    const cancelled = await request(app)
      .patch(`/api/v1/bookings/${bookingId}/status`)
      .set("Cookie", owner.cookie)
      .send({ status: "CANCELLED" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.booking.status).toBe("CANCELLED");
    expect(cancelled.body.data.booking.cancelledAt).toBeTruthy();

    // The freed slot can be booked again.
    const rebook = await createBooking(owner, {
      businessId: businessA,
      customerId: customerA,
      startAt: slot.startAt,
    });
    expect(rebook.status).toBe(201);

    // ...and a terminal booking cannot be cancelled twice.
    const reopen = await request(app)
      .patch(`/api/v1/bookings/${bookingId}/status`)
      .set("Cookie", owner.cookie)
      .send({ status: "CANCELLED" });
    expect(reopen.status).toBe(200); // same-status no-op stays valid
    const revive = await request(app)
      .patch(`/api/v1/bookings/${bookingId}/status`)
      .set("Cookie", owner.cookie)
      .send({ status: "CONFIRMED" });
    expect(revive.status).toBe(400);
  });
});

describe("listing (§35)", () => {
  it("lists a business's bookings for a range and scopes out other tenants", async () => {
    const from = new Date();
    const to = new Date(from.getTime() + 40 * 24 * 60 * 60 * 1000);

    const res = await request(app)
      .get("/api/v1/bookings")
      .set("Cookie", owner.cookie)
      .query({ businessId: businessA, from: from.toISOString(), to: to.toISOString() });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.bookings)).toBe(true);
    expect(res.body.data.bookings.length).toBeGreaterThan(0);
    expect(res.body.data.bookings[0].customer).toBeTruthy();

    const foreign = await request(app)
      .get("/api/v1/bookings")
      .set("Cookie", owner.cookie)
      .query({ businessId: businessB });
    expect(foreign.status).toBe(404);
  });
});
