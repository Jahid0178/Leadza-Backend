import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { LEAD_STATUS_TRANSITIONS, canTransitionLead } from "../src/services/lead-status";

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
let staff: Actor;
let outsider: Actor;
let businessA: string;
let businessB: string;
let customerA: string;
let customerB: string;
let serviceA: string;
let leadId: string;

/** Create a customer via the API and return its id. */
async function createCustomer(actor: Actor, business: string, phone: string) {
  const res = await request(app)
    .post("/api/v1/customers")
    .set("Cookie", actor.cookie)
    .send({ businessId: business, name: "Lead Fixture", phone });
  if (res.status !== 201) throw new Error(`customer create failed: ${res.status}`);
  return res.body.data.customer.id as string;
}

/** Create a lead via the API and return its id. */
async function createLead(actor: Actor, business: string, customerId: string, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/v1/leads")
    .set("Cookie", actor.cookie)
    .send({ businessId: business, customerId, ...extra });
  if (res.status !== 201) throw new Error(`lead create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.lead.id as string;
}

beforeAll(async () => {
  [owner, staff, outsider] = await Promise.all([
    registerActor("lowner"),
    registerActor("lstf"),
    registerActor("lout"),
  ]);

  const create = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", owner.cookie)
    .send({ name: "Lead Test Plumbing", type: "Plumber" });
  businessA = create.body.data.business.id as string;

  const foreign = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", outsider.cookie)
    .send({ name: "Foreign Lead Heating", type: "Heating" });
  businessB = foreign.body.data.business.id as string;

  await prisma.businessMember.create({
    data: { businessId: businessA, userId: staff.userId, role: "STAFF" },
  });

  customerA = await createCustomer(owner, businessA, "07700 900111");
  customerB = await createCustomer(outsider, businessB, "07700 900222");

  const service = await request(app)
    .post("/api/v1/services")
    .set("Cookie", owner.cookie)
    .send({ businessId: businessA, name: "Boiler Repair", price: 90, priceType: "FROM" });
  serviceA = service.body.data.service.id as string;
});

afterAll(async () => {
  const ids = [owner, staff, outsider].map((a) => a.userId);
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.business.deleteMany({
    where: { name: { in: ["Lead Test Plumbing", "Foreign Lead Heating"] } },
  });
});

describe("lead creation (§15, step 14)", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/v1/leads");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("creates a lead as OWNER with NEW status and captured fields", async () => {
    const res = await request(app)
      .post("/api/v1/leads")
      .set("Cookie", owner.cookie)
      .send({
        businessId: businessA,
        customerId: customerA,
        serviceId: serviceA,
        source: "WEBSITE",
        urgency: "HIGH",
        location: "Reading",
        postcode: "RG1 4AB",
        budget: 150,
        preferredTime: "Morning",
        customerMessage: "My boiler isn't working and it's cold.",
      });
    expect(res.status).toBe(201);
    const lead = res.body.data.lead;
    expect(lead.status).toBe("NEW");
    expect(lead.urgency).toBe("HIGH");
    expect(lead.source).toBe("WEBSITE");
    expect(lead.leadScore).toBeNull();
    expect(lead.customer.name).toBe("Lead Fixture");
    expect(lead.service?.name).toBe("Boiler Repair");
    leadId = lead.id;
  });

  it("lets STAFF create a lead (operational work, not OWNER-only)", async () => {
    const id = await createLead(staff, businessA, customerA);
    expect(id).toBeTruthy();
  });

  it("rejects a customer from another business (§13)", async () => {
    const res = await request(app)
      .post("/api/v1/leads")
      .set("Cookie", owner.cookie)
      .send({ businessId: businessA, customerId: customerB });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects a service from another business (§13)", async () => {
    const res = await request(app)
      .post("/api/v1/leads")
      .set("Cookie", owner.cookie)
      .send({ businessId: businessA, customerId: customerA, serviceId: "not-a-service" });
    expect(res.status).toBe(404);
  });

  it("rejects an unknown source or urgency", async () => {
    const badSource = await request(app)
      .post("/api/v1/leads")
      .set("Cookie", owner.cookie)
      .send({ businessId: businessA, customerId: customerA, source: "CARRIER_PIGEON" });
    expect(badSource.status).toBe(400);

    const badUrgency = await request(app)
      .post("/api/v1/leads")
      .set("Cookie", owner.cookie)
      .send({ businessId: businessA, customerId: customerA, urgency: "CRITICAL" });
    expect(badUrgency.status).toBe(400);
  });
});

describe("lead status transitions (§15, agent.md §19)", () => {
  it("walks the happy path NEW → CONTACTED → QUALIFYING → QUALIFIED → BOOKED → WON", async () => {
    const id = await createLead(owner, businessA, customerA);
    for (const status of ["CONTACTED", "QUALIFYING", "QUALIFIED", "BOOKED", "WON"]) {
      const res = await request(app)
        .patch(`/api/v1/leads/${id}/status`)
        .set("Cookie", owner.cookie)
        .send({ status });
      expect(res.status, `expected ${status} to be allowed`).toBe(200);
      expect(res.body.data.lead.status).toBe(status);
    }
  });

  it("rejects a jump over the lifecycle (NEW → WON) with INVALID_TRANSITION", async () => {
    const id = await createLead(owner, businessA, customerA);
    const res = await request(app)
      .patch(`/api/v1/leads/${id}/status`)
      .set("Cookie", owner.cookie)
      .send({ status: "WON" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_TRANSITION");
    // The lead is untouched.
    const read = await request(app)
      .get(`/api/v1/leads/${id}`)
      .set("Cookie", owner.cookie);
    expect(read.body.data.lead.status).toBe("NEW");
  });

  it("treats the same status as an idempotent no-op", async () => {
    const res = await request(app)
      .patch(`/api/v1/leads/${leadId}/status`)
      .set("Cookie", owner.cookie)
      .send({ status: "NEW" });
    expect(res.status).toBe(200);
    expect(res.body.data.lead.status).toBe("NEW");
  });

  it("lets alternative outcomes fire from any non-terminal status", async () => {
    for (const outcome of ["SPAM", "CANCELLED", "LOST"] as const) {
      const id = await createLead(owner, businessA, customerA);
      const res = await request(app)
        .patch(`/api/v1/leads/${id}/status`)
        .set("Cookie", owner.cookie)
        .send({ status: outcome });
      expect(res.status, `expected ${outcome} from NEW`).toBe(200);
    }
  });

  it("locks terminal statuses (WON, LOST, SPAM, CANCELLED)", async () => {
    // Shortest path from NEW to each terminal state (agent.md §19).
    const reach: Record<string, string[]> = {
      WON: ["CONTACTED", "QUALIFYING", "QUALIFIED", "BOOKED", "WON"],
      LOST: ["LOST"],
      SPAM: ["SPAM"],
      CANCELLED: ["CANCELLED"],
    };

    for (const terminal of ["WON", "LOST", "SPAM", "CANCELLED"] as const) {
      const id = await createLead(owner, businessA, customerA);
      for (const step of reach[terminal] ?? []) {
        const walked = await request(app)
          .patch(`/api/v1/leads/${id}/status`)
          .set("Cookie", owner.cookie)
          .send({ status: step });
        expect(walked.status, `setup ${terminal} via ${step}`).toBe(200);
      }
      // Confirm the lead really is terminal before probing escapes.
      const before = await request(app)
        .get(`/api/v1/leads/${id}`)
        .set("Cookie", owner.cookie);
      expect(before.body.data.lead.status).toBe(terminal);

      for (const status of ["NEW", "CONTACTED", "QUALIFIED", "BOOKED"]) {
        const res = await request(app)
          .patch(`/api/v1/leads/${id}/status`)
          .set("Cookie", owner.cookie)
          .send({ status });
        expect(res.status, `expected ${terminal} → ${status} rejected`).toBe(400);
        expect(res.body.error.code).toBe("INVALID_TRANSITION");
      }
    }
  }, 60000);

  it("lets STAFF change status (operational work)", async () => {
    const id = await createLead(owner, businessA, customerA);
    const res = await request(app)
      .patch(`/api/v1/leads/${id}/status`)
      .set("Cookie", staff.cookie)
      .send({ status: "CONTACTED" });
    expect(res.status).toBe(200);
  });

  it("agrees with the transition table on every (from, to) pair", () => {
    // The pure function is the single source of truth the API delegates to
    // (agent.md §19); the HTTP spot-checks above prove the wiring.
    const statuses = Object.keys(LEAD_STATUS_TRANSITIONS) as Array<
      keyof typeof LEAD_STATUS_TRANSITIONS
    >;

    for (const from of statuses) {
      for (const to of statuses) {
        const allowed = canTransitionLead(from, to);
        if (from === to) {
          expect(allowed, `${from} → ${to} is an idempotent no-op`).toBe(true);
        } else {
          expect(
            allowed,
            `${from} → ${to} should be ${LEAD_STATUS_TRANSITIONS[from].includes(to) ? "allowed" : "rejected"}`,
          ).toBe(LEAD_STATUS_TRANSITIONS[from].includes(to));
        }
      }
    }

    // Terminal statuses have no outgoing transitions at all.
    for (const terminal of ["WON", "LOST", "SPAM", "CANCELLED"] as const) {
      expect(LEAD_STATUS_TRANSITIONS[terminal]).toEqual([]);
    }
  });
});

describe("lead list filters and pagination (§29, step 14)", () => {
  let filteredBusiness: string;
  let filteredCustomer: string;

  beforeAll(async () => {
    const biz = await request(app)
      .post("/api/v1/businesses")
      .set("Cookie", owner.cookie)
      .send({ name: `Filter Biz ${stamp}` });
    filteredBusiness = biz.body.data.business.id as string;
    filteredCustomer = await createCustomer(owner, filteredBusiness, "07700 900333");
  });

  it("filters by status, urgency, and source", async () => {
    const highId = await createLead(owner, filteredBusiness, filteredCustomer, {
      urgency: "HIGH",
      source: "WEBSITE",
    });
    const lowId = await createLead(owner, filteredBusiness, filteredCustomer, {
      urgency: "LOW",
      source: "EMAIL",
    });
    await request(app)
      .patch(`/api/v1/leads/${lowId}/status`)
      .set("Cookie", owner.cookie)
      .send({ status: "CONTACTED" });

    const byStatus = await request(app)
      .get("/api/v1/leads")
      .query({ businessId: filteredBusiness, status: "NEW" })
      .set("Cookie", owner.cookie);
    expect(byStatus.status).toBe(200);
    const newIds = byStatus.body.data.leads.map((l: { id: string }) => l.id);
    expect(newIds).toContain(highId);
    expect(newIds).not.toContain(lowId);

    const byUrgency = await request(app)
      .get("/api/v1/leads")
      .query({ businessId: filteredBusiness, urgency: "HIGH" })
      .set("Cookie", owner.cookie);
    expect(byUrgency.body.data.leads.every((l: { urgency: string }) => l.urgency === "HIGH")).toBe(true);

    const bySource = await request(app)
      .get("/api/v1/leads")
      .query({ businessId: filteredBusiness, source: "EMAIL" })
      .set("Cookie", owner.cookie);
    expect(bySource.body.data.leads.map((l: { id: string }) => l.id)).toEqual([lowId]);
  });

  it("searches across customer contact details and message", async () => {
    const res = await request(app)
      .get("/api/v1/leads")
      .query({ businessId: filteredBusiness, search: "900333" })
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.leads.length).toBeGreaterThan(0);
    expect(
      res.body.data.leads.every(
        (l: { customer: { phone: string } }) => l.customer.phone.includes("900333"),
      ),
    ).toBe(true);
  });

  it("paginates with total, page, and pageSize", async () => {
    const res = await request(app)
      .get("/api/v1/leads")
      .query({ businessId: filteredBusiness, page: 1, pageSize: 1 })
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.leads).toHaveLength(1);
    expect(res.body.data.page).toBe(1);
    expect(res.body.data.pageSize).toBe(1);
    expect(res.body.data.total).toBeGreaterThanOrEqual(2);

    const page2 = await request(app)
      .get("/api/v1/leads")
      .query({ businessId: filteredBusiness, page: 2, pageSize: 1 })
      .set("Cookie", owner.cookie);
    expect(page2.body.data.leads).toHaveLength(1);
    expect(page2.body.data.leads[0].id).not.toBe(res.body.data.leads[0].id);
  });

  it("rejects an invalid filter value", async () => {
    const res = await request(app)
      .get("/api/v1/leads")
      .query({ businessId: filteredBusiness, status: "MADE_UP" })
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("lead tenant isolation (§13, §60)", () => {
  it("denies cross-tenant list, read, update, and status change", async () => {
    const list = await request(app)
      .get("/api/v1/leads")
      .query({ businessId: businessB })
      .set("Cookie", owner.cookie);
    expect(list.status).toBe(404);

    const read = await request(app)
      .get(`/api/v1/leads/${leadId}`)
      .set("Cookie", outsider.cookie);
    expect(read.status).toBe(404);

    const update = await request(app)
      .patch(`/api/v1/leads/${leadId}`)
      .set("Cookie", outsider.cookie)
      .send({ urgency: "LOW" });
    expect(update.status).toBe(404);

    const status = await request(app)
      .patch(`/api/v1/leads/${leadId}/status`)
      .set("Cookie", outsider.cookie)
      .send({ status: "WON" });
    expect(status.status).toBe(404);
  });

  it("denies a foreign businessId on create", async () => {
    const res = await request(app)
      .post("/api/v1/leads")
      .set("Cookie", outsider.cookie)
      .send({ businessId: businessA, customerId: customerA });
    expect(res.status).toBe(404);
  });
});

describe("lead qualification updates (§17, step 14)", () => {
  it("updates qualification fields and rejects an empty patch", async () => {
    const update = await request(app)
      .patch(`/api/v1/leads/${leadId}`)
      .set("Cookie", owner.cookie)
      .send({ urgency: "MEDIUM", budget: 200, preferredDate: "2026-10-20" });
    expect(update.status).toBe(200);
    expect(update.body.data.lead.urgency).toBe("MEDIUM");
    expect(update.body.data.lead.budget).toBe(200);

    const empty = await request(app)
      .patch(`/api/v1/leads/${leadId}`)
      .set("Cookie", owner.cookie)
      .send({});
    expect(empty.status).toBe(400);
  });

  it("never changes status through the qualification patch", async () => {
    const res = await request(app)
      .patch(`/api/v1/leads/${leadId}`)
      .set("Cookie", owner.cookie)
      .send({ status: "WON", urgency: "HIGH" });
    // `status` is not a recognized field — the schema rejects it outright so
    // no path exists from here to a status change (agent.md §19).
    expect(res.status).toBe(400);
    const read = await request(app)
      .get(`/api/v1/leads/${leadId}`)
      .set("Cookie", owner.cookie);
    expect(read.body.data.lead.status).toBe("NEW");
  });
});
