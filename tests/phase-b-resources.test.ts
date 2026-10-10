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

/** Extract the Auth.js session cookie from a response. */
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

// Fixture: business A (owner + staff), business B owned by an outsider.
let owner: Actor;
let admin: Actor;
let staff: Actor;
let outsider: Actor;
let businessA: string;
let businessB: string;

// Created resources, reused across assertions.
let serviceId: string;
let areaId: string;
let hourId: string;
let entryId: string;

beforeAll(async () => {
  [owner, admin, staff, outsider] = await Promise.all([
    registerActor("powner"),
    registerActor("padmin"),
    registerActor("pstf"),
    registerActor("pout"),
  ]);

  const create = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", owner.cookie)
    .send({ name: "Phase B Plumbing", type: "Plumber" });
  if (create.status !== 201) {
    throw new Error(`business create failed: ${JSON.stringify(create.body)}`);
  }
  businessA = create.body.data.business.id as string;

  const foreign = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", outsider.cookie)
    .send({ name: "Foreign Heating", type: "Heating" });
  businessB = foreign.body.data.business.id as string;

  // ADMIN/STAFF membership is not provisioned by any API yet — seed directly (§6).
  await prisma.businessMember.createMany({
    data: [
      { businessId: businessA, userId: admin.userId, role: "ADMIN" },
      { businessId: businessA, userId: staff.userId, role: "STAFF" },
    ],
  });
});

afterAll(async () => {
  const ids = [owner, admin, staff, outsider].map((a) => a.userId);
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.business.deleteMany({ where: { id: { in: [businessA, businessB] } } });
});

describe("services (§10, step 09)", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/v1/services");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects an invalid service before touching the database", async () => {
    const res = await request(app)
      .post("/api/v1/services")
      .set("Cookie", owner.cookie)
      .send({ businessId: businessA, name: "X", price: -5 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("creates a service as OWNER and persists pricing from this table", async () => {
    const res = await request(app)
      .post("/api/v1/services")
      .set("Cookie", owner.cookie)
      .send({
        businessId: businessA,
        name: "Boiler Repair",
        description: "Diagnose and fix common boiler faults.",
        price: 90,
        priceType: "FROM",
        duration: 60,
      });
    expect(res.status).toBe(201);
    const service = res.body.data.service;
    expect(service.id).toBeTruthy();
    expect(service.businessId).toBe(businessA);
    expect(service.price).toBe(90);
    expect(service.priceType).toBe("FROM");
    expect(service.duration).toBe(60);
    expect(service.active).toBe(true);
    serviceId = service.id;
  });

  it("lists services for a business the caller belongs to", async () => {
    const res = await request(app)
      .get("/api/v1/services")
      .query({ businessId: businessA })
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.services).toHaveLength(1);
    expect(res.body.data.services[0].name).toBe("Boiler Repair");
  });

  it("lists an empty business's services instead of 404", async () => {
    const empty = await request(app)
      .post("/api/v1/businesses")
      .set("Cookie", owner.cookie)
      .send({ name: `Empty Biz ${stamp}` });
    const emptyId = empty.body.data.business.id as string;

    const res = await request(app)
      .get("/api/v1/services")
      .query({ businessId: emptyId })
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.services).toEqual([]);

    await prisma.business.delete({ where: { id: emptyId } });
  });

  it("denies cross-tenant list and read of another business's services", async () => {
    const list = await request(app)
      .get("/api/v1/services")
      .query({ businessId: businessB })
      .set("Cookie", owner.cookie);
    expect(list.status).toBe(404);
    expect(list.body.error.code).toBe("NOT_FOUND");

    const read = await request(app)
      .get(`/api/v1/services/${serviceId}`)
      .set("Cookie", outsider.cookie);
    expect(read.status).toBe(404);
  });

  it("refuses STAFF mutations with 403 ROLE_REQUIRED", async () => {
    const res = await request(app)
      .post("/api/v1/services")
      .set("Cookie", staff.cookie)
      .send({ businessId: businessA, name: "Staff Service" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ROLE_REQUIRED");

    const patch = await request(app)
      .patch(`/api/v1/services/${serviceId}`)
      .set("Cookie", staff.cookie)
      .send({ price: 10 });
    expect(patch.status).toBe(403);
  });

  it("refuses STAFF from a foreign business with 404 (membership first)", async () => {
    const res = await request(app)
      .post("/api/v1/services")
      .set("Cookie", outsider.cookie)
      .send({ businessId: businessA, name: "Hijacked" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("updates a service as ADMIN", async () => {
    const res = await request(app)
      .patch(`/api/v1/services/${serviceId}`)
      .set("Cookie", admin.cookie)
      .send({ price: 95, description: "Updated description." });
    expect(res.status).toBe(200);
    expect(res.body.data.service.price).toBe(95);
    expect(res.body.data.service.description).toBe("Updated description.");
  });

  it("rejects an empty patch", async () => {
    const res = await request(app)
      .patch(`/api/v1/services/${serviceId}`)
      .set("Cookie", owner.cookie)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("soft-deletes a service (active=false) as OWNER", async () => {
    const res = await request(app)
      .delete(`/api/v1/services/${serviceId}`)
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.service.active).toBe(false);
  });
});

describe("service areas (§11, step 10)", () => {
  it("creates an area as OWNER", async () => {
    const res = await request(app)
      .post("/api/v1/areas")
      .set("Cookie", owner.cookie)
      .send({ businessId: businessA, value: "RG1", label: "Reading town centre" });
    expect(res.status).toBe(201);
    expect(res.body.data.area.value).toBe("RG1");
    expect(res.body.data.area.businessId).toBe(businessA);
    areaId = res.body.data.area.id as string;
  });

  it("rejects an empty area value", async () => {
    const res = await request(app)
      .post("/api/v1/areas")
      .set("Cookie", owner.cookie)
      .send({ businessId: businessA, value: "" });
    expect(res.status).toBe(400);
  });

  it("denies cross-tenant list, read, and write", async () => {
    const list = await request(app)
      .get("/api/v1/areas")
      .query({ businessId: businessB })
      .set("Cookie", owner.cookie);
    expect(list.status).toBe(404);

    const read = await request(app)
      .get(`/api/v1/areas/${areaId}`)
      .set("Cookie", outsider.cookie);
    expect(read.status).toBe(404);

    const write = await request(app)
      .post("/api/v1/areas")
      .set("Cookie", outsider.cookie)
      .send({ businessId: businessA, value: "HACKED" });
    expect(write.status).toBe(404);
  });

  it("refuses STAFF with 403", async () => {
    const res = await request(app)
      .post("/api/v1/areas")
      .set("Cookie", staff.cookie)
      .send({ businessId: businessA, value: "RG2" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ROLE_REQUIRED");
  });

  it("updates and deletes an area as OWNER", async () => {
    const update = await request(app)
      .patch(`/api/v1/areas/${areaId}`)
      .set("Cookie", owner.cookie)
      .send({ radiusKm: 10 });
    expect(update.status).toBe(200);
    expect(update.body.data.area.radiusKm).toBe(10);

    const remove = await request(app)
      .delete(`/api/v1/areas/${areaId}`)
      .set("Cookie", owner.cookie);
    expect(remove.status).toBe(200);

    const gone = await request(app)
      .get(`/api/v1/areas/${areaId}`)
      .set("Cookie", owner.cookie);
    expect(gone.status).toBe(404);
  });
});

describe("business hours (§12, step 11)", () => {
  it("creates weekday hours as OWNER", async () => {
    const res = await request(app)
      .post("/api/v1/hours")
      .set("Cookie", owner.cookie)
      .send({
        businessId: businessA,
        weekday: "MONDAY",
        startTime: "08:00",
        endTime: "18:00",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.hour.weekday).toBe("MONDAY");
    expect(res.body.data.hour.closed).toBe(false);
    hourId = res.body.data.hour.id as string;
  });

  it("rejects a malformed time", async () => {
    const res = await request(app)
      .post("/api/v1/hours")
      .set("Cookie", owner.cookie)
      .send({ businessId: businessA, weekday: "TUESDAY", startTime: "8am", endTime: "18:00" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("denies cross-tenant access", async () => {
    const list = await request(app)
      .get("/api/v1/hours")
      .query({ businessId: businessB })
      .set("Cookie", owner.cookie);
    expect(list.status).toBe(404);

    const read = await request(app)
      .get(`/api/v1/hours/${hourId}`)
      .set("Cookie", outsider.cookie);
    expect(read.status).toBe(404);

    const write = await request(app)
      .post("/api/v1/hours")
      .set("Cookie", outsider.cookie)
      .send({ businessId: businessA, weekday: "SUNDAY", startTime: "09:00", endTime: "17:00" });
    expect(write.status).toBe(404);
  });

  it("refuses STAFF with 403", async () => {
    const res = await request(app)
      .post("/api/v1/hours")
      .set("Cookie", staff.cookie)
      .send({ businessId: businessA, weekday: "SATURDAY", startTime: "09:00", endTime: "14:00" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ROLE_REQUIRED");
  });

  it("marks a day closed as ADMIN", async () => {
    const res = await request(app)
      .patch(`/api/v1/hours/${hourId}`)
      .set("Cookie", admin.cookie)
      .send({ closed: true });
    expect(res.status).toBe(200);
    expect(res.body.data.hour.closed).toBe(true);
  });

  it("deletes an hour as OWNER", async () => {
    const res = await request(app)
      .delete(`/api/v1/hours/${hourId}`)
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(200);

    const gone = await request(app)
      .get(`/api/v1/hours/${hourId}`)
      .set("Cookie", owner.cookie);
    expect(gone.status).toBe(404);
  });
});

describe("knowledge entries (§13, step 12)", () => {
  it("creates an entry as OWNER", async () => {
    const res = await request(app)
      .post("/api/v1/knowledge")
      .set("Cookie", owner.cookie)
      .send({
        businessId: businessA,
        question: "Do you offer emergency callouts?",
        answer: "Yes — 24/7 emergency callouts across RG1–RG4.",
        category: "EMERGENCY",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.knowledge.category).toBe("EMERGENCY");
    expect(res.body.data.knowledge.isActive).toBe(true);
    entryId = res.body.data.knowledge.id as string;
  });

  it("rejects an entry that is too short", async () => {
    const res = await request(app)
      .post("/api/v1/knowledge")
      .set("Cookie", owner.cookie)
      .send({ businessId: businessA, question: "Hi", answer: "Yes." });
    expect(res.status).toBe(400);
  });

  it("keeps knowledge scoped to one business (cross-tenant denied)", async () => {
    const list = await request(app)
      .get("/api/v1/knowledge")
      .query({ businessId: businessB })
      .set("Cookie", owner.cookie);
    expect(list.status).toBe(404);

    const read = await request(app)
      .get(`/api/v1/knowledge/${entryId}`)
      .set("Cookie", outsider.cookie);
    expect(read.status).toBe(404);

    const write = await request(app)
      .post("/api/v1/knowledge")
      .set("Cookie", outsider.cookie)
      .send({ businessId: businessA, question: "Q?", answer: "A." });
    expect(write.status).toBe(404);
  });

  it("refuses STAFF with 403", async () => {
    const res = await request(app)
      .post("/api/v1/knowledge")
      .set("Cookie", staff.cookie)
      .send({ businessId: businessA, question: "Q?", answer: "A." });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ROLE_REQUIRED");
  });

  it("updates an entry as ADMIN", async () => {
    const res = await request(app)
      .patch(`/api/v1/knowledge/${entryId}`)
      .set("Cookie", admin.cookie)
      .send({ answer: "Yes — 24/7 emergency callouts, RG1 to RG4 inclusive." });
    expect(res.status).toBe(200);
    expect(res.body.data.knowledge.answer).toContain("inclusive");
  });

  it("archives an entry as OWNER so it leaves the list", async () => {
    const res = await request(app)
      .delete(`/api/v1/knowledge/${entryId}`)
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(200);
    // Archiving hides the row without touching its draft/published flag.
    expect(res.body.data.knowledge.id).toBe(entryId);

    const list = await request(app)
      .get("/api/v1/knowledge")
      .query({ businessId: businessA })
      .set("Cookie", owner.cookie);
    expect(list.status).toBe(200);
    expect(list.body.data.knowledge).toEqual([]);
  });

  it("saves entry type, free-text category, tags and draft status", async () => {
    const create = await request(app)
      .post("/api/v1/knowledge")
      .set("Cookie", owner.cookie)
      .send({
        businessId: businessA,
        question: "What payment methods do you accept?",
        answer: "Cash, card and bank transfer; finance is available on larger jobs.",
        type: "BUSINESS",
        category: "Pricing & payments",
        tags: ["payments", "finance"],
        isActive: false,
      });
    expect(create.status).toBe(201);
    const entry = create.body.data.knowledge;
    expect(entry.type).toBe("BUSINESS");
    expect(entry.category).toBe("Pricing & payments");
    expect(entry.tags).toEqual(["payments", "finance"]);
    expect(entry.isActive).toBe(false);

    // A draft still appears in the dashboard list (it is only hidden from
    // the AI until it is published).
    const list = await request(app)
      .get("/api/v1/knowledge")
      .query({ businessId: businessA })
      .set("Cookie", owner.cookie);
    expect(list.status).toBe(200);
    expect(list.body.data.knowledge).toHaveLength(1);
    expect(list.body.data.knowledge[0].id).toBe(entry.id);

    // Archiving is separate from the draft flag and keeps the row.
    const archive = await request(app)
      .delete(`/api/v1/knowledge/${entry.id}`)
      .set("Cookie", owner.cookie);
    expect(archive.status).toBe(200);

    const row = await prisma.knowledgeEntry.findUnique({ where: { id: entry.id } });
    expect(row).not.toBeNull();
    expect(row?.archivedAt).not.toBeNull();
    expect(row?.category).toBe("Pricing & payments");
  });

  it("rejects an empty category and an unknown entry type", async () => {
    const emptyCategory = await request(app)
      .post("/api/v1/knowledge")
      .set("Cookie", owner.cookie)
      .send({
        businessId: businessA,
        question: "Where are you based?",
        answer: "Reading and the surrounding areas.",
        category: "",
      });
    expect(emptyCategory.status).toBe(400);

    const badType = await request(app)
      .post("/api/v1/knowledge")
      .set("Cookie", owner.cookie)
      .send({
        businessId: businessA,
        question: "Do you work weekends?",
        answer: "Saturdays by arrangement.",
        type: "NOTICE",
      });
    expect(badType.status).toBe(400);
    expect(badType.body.error.code).toBe("VALIDATION_ERROR");
  });
});
