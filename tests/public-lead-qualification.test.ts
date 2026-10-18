import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";

/**
 * Enquiry qualification fields (FEATURES §15, §17; IMPLEMENTATION_PLAN steps
 * 18–19): the widget's service select, urgency menu and preferred date land
 * on the lead created by the public enquiry form.
 *
 * Deliberately its own file rather than an addition to public-leads.test.ts:
 * that suite ends by *filling* the public endpoint's 10-per-window rate limit
 * on purpose, and vitest isolates files into fresh processes — so this file
 * gets a fresh limiter store and its submissions can never collide with that
 * tripwire (or each other, across a rerun in the same window).
 *
 * The service must belong to THIS business and be active: a foreign or
 * archived id is ignored, never linked (§13).
 */

const app = createApp();
const stamp = Date.now();
const password = "s3cure-pass-1";

interface Actor {
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
  const res = await request(app)
    .post("/api/v1/auth/register")
    .send({ name: `Actor ${label}`, email: `${label}-${stamp}@example.com`, password });
  if (res.status !== 201) throw new Error(`register failed for ${label}: ${res.status}`);
  return { cookie: sessionCookieFrom(res), userId: res.body.data.user.id as string };
}

let owner: Actor;
let otherOwner: Actor;
let businessId: string;
let otherBusinessId: string;
/** Active in `businessId` — the one service the widget's select may offer. */
let boilerId: string;
/** Active but archived (`active: false`) in `businessId`. */
let archivedId: string;
/** Active in another tenant — must never link across businesses. */
let foreignId: string;

/** Submit an enquiry with unique defaults so nothing folds as a duplicate. */
let sequence = 0;
function submit(extra: Record<string, unknown> = {}) {
  sequence += 1;
  return request(app)
    .post(`/api/v1/leads/public/${businessId}`)
    .send({
      name: "Qualified Visitor",
      phone: `07700 901${String(sequence).padStart(3, "0")}`,
      message: `Qualification test ${sequence}: the boiler is leaking.`,
      ...extra,
    });
}

async function leadFrom(res: request.Response) {
  return prisma.lead.findUniqueOrThrow({
    where: { id: res.body.data.lead.id as string },
  });
}

beforeAll(async () => {
  [owner, otherOwner] = await Promise.all([
    registerActor("qowner"),
    registerActor("qother"),
  ]);

  const business = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", owner.cookie)
    .send({ name: `Qualify Plumbing ${stamp}`, type: "Plumber" });
  if (business.status !== 201) throw new Error("business create failed");
  businessId = business.body.data.business.id as string;

  const foreign = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", otherOwner.cookie)
    .send({ name: `Qualify Foreign Heating ${stamp}`, type: "Heating" });
  if (foreign.status !== 201) throw new Error("foreign business create failed");
  otherBusinessId = foreign.body.data.business.id as string;

  const boiler = await prisma.service.create({
    data: { businessId, name: "Boiler Repair", price: 90, priceType: "FROM", active: true },
  });
  boilerId = boiler.id;

  const archived = await prisma.service.create({
    data: { businessId, name: "Retired Callouts", price: 20, priceType: "FROM", active: false },
  });
  archivedId = archived.id;

  const foreignService = await prisma.service.create({
    data: { businessId: otherBusinessId, name: "Foreign Service", price: 30, priceType: "FROM", active: true },
  });
  foreignId = foreignService.id;
}, 60000);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [owner.userId, otherOwner.userId] } } });
  await prisma.business.deleteMany({
    where: { id: { in: [businessId, otherBusinessId] } },
  });
});

describe("enquiry qualification fields (§15, §17)", () => {
  it("stores the selected service, urgency and preferred date on the lead", async () => {
    const res = await submit({
      serviceId: boilerId,
      urgency: "HIGH",
      preferredDate: "2026-12-01",
    });
    expect(res.status).toBe(201);

    const lead = await leadFrom(res);
    expect(lead.serviceId).toBe(boilerId);
    expect(lead.urgency).toBe("HIGH");
    expect(lead.preferredDate?.toISOString().slice(0, 10)).toBe("2026-12-01");
  });

  it("still links a service by free-text name (hand-rolled embeds)", async () => {
    const res = await submit({ serviceName: "Boiler Repair" });
    expect(res.status).toBe(201);

    const lead = await leadFrom(res);
    expect(lead.serviceId).toBe(boilerId);
  });

  it("ignores a service id from another business but keeps urgency (§13)", async () => {
    const res = await submit({ serviceId: foreignId, urgency: "MEDIUM" });
    expect(res.status).toBe(201);

    const lead = await leadFrom(res);
    expect(lead.serviceId).toBeNull();
    expect(lead.urgency).toBe("MEDIUM");
  });

  it("ignores an archived service id", async () => {
    const res = await submit({ serviceId: archivedId });
    expect(res.status).toBe(201);

    const lead = await leadFrom(res);
    expect(lead.serviceId).toBeNull();
  });

  it("rejects an urgency value outside the enum", async () => {
    const res = await submit({ urgency: "URGENT" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});