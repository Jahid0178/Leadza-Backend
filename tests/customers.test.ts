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
let staff: Actor;
let outsider: Actor;
let businessA: string;
let businessB: string;

let customerId: string;

beforeAll(async () => {
  [owner, staff, outsider] = await Promise.all([
    registerActor("cowner"),
    registerActor("cstf"),
    registerActor("cout"),
  ]);

  const create = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", owner.cookie)
    .send({ name: "Customer Test Plumbing", type: "Plumber" });
  if (create.status !== 201) {
    throw new Error(`business create failed: ${JSON.stringify(create.body)}`);
  }
  businessA = create.body.data.business.id as string;

  const foreign = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", outsider.cookie)
    .send({ name: "Foreign Customer Heating", type: "Heating" });
  businessB = foreign.body.data.business.id as string;

  // STAFF membership is not provisioned by any API yet — seed directly (§6).
  await prisma.businessMember.create({
    data: { businessId: businessA, userId: staff.userId, role: "STAFF" },
  });
});

afterAll(async () => {
  const ids = [owner, staff, outsider].map((a) => a.userId);
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.business.deleteMany({
    where: { name: { in: ["Customer Test Plumbing", "Foreign Customer Heating"] } },
  });
});

describe("customers (§14, step 13)", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/v1/customers");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a find-or-create with neither phone nor email", async () => {
    const res = await request(app)
      .post("/api/v1/customers")
      .set("Cookie", owner.cookie)
      .send({ businessId: businessA, name: "No Contact" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("creates a customer as OWNER (201) and returns created=true", async () => {
    const res = await request(app)
      .post("/api/v1/customers")
      .set("Cookie", owner.cookie)
      .send({
        businessId: businessA,
        name: "Jane Doe",
        phone: "07700 900123",
        email: "jane@example.com",
        postcode: "RG1 4AB",
      });
    expect(res.status).toBe(201);
    const customer = res.body.data.customer;
    expect(customer.id).toBeTruthy();
    expect(customer.businessId).toBe(businessA);
    expect(customer.name).toBe("Jane Doe");
    expect(res.body.data.created).toBe(true);
    customerId = customer.id as string;
  });

  it("finds the same customer on a repeat with a differently formatted phone", async () => {
    const res = await request(app)
      .post("/api/v1/customers")
      .set("Cookie", owner.cookie)
      .send({ businessId: businessA, name: "J. Doe", phone: "07700-900123" });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(false);
    expect(res.body.data.customer.id).toBe(customerId);
    // The original record is not overwritten by the find.
    expect(res.body.data.customer.name).toBe("Jane Doe");
  });

  it("finds the same customer by email", async () => {
    const res = await request(app)
      .post("/api/v1/customers")
      .set("Cookie", owner.cookie)
      .send({ businessId: businessA, name: "Jane D.", email: "JANE@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(false);
    expect(res.body.data.customer.id).toBe(customerId);
  });

  it("lists customers for a business the caller belongs to", async () => {
    const res = await request(app)
      .get("/api/v1/customers")
      .query({ businessId: businessA })
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.customers).toHaveLength(1);
    expect(res.body.data.customers[0].name).toBe("Jane Doe");
  });

  it("lets STAFF read and find-or-create (member-wide, not OWNER-only)", async () => {
    const list = await request(app)
      .get("/api/v1/customers")
      .query({ businessId: businessA })
      .set("Cookie", staff.cookie);
    expect(list.status).toBe(200);
    expect(list.body.data.customers).toHaveLength(1);

    const create = await request(app)
      .post("/api/v1/customers")
      .set("Cookie", staff.cookie)
      .send({ businessId: businessA, name: "Bob Smith", phone: "07700 900999" });
    expect(create.status).toBe(201);
  });

  it("keeps customers scoped to one business (cross-tenant denied)", async () => {
    // Same phone as business A's Jane — business B must get its own record.
    const create = await request(app)
      .post("/api/v1/customers")
      .set("Cookie", outsider.cookie)
      .send({ businessId: businessB, name: "Jane Doe", phone: "07700 900123" });
    expect(create.status).toBe(201);
    expect(create.body.data.created).toBe(true);
    expect(create.body.data.customer.id).not.toBe(customerId);
    expect(create.body.data.customer.businessId).toBe(businessB);

    const list = await request(app)
      .get("/api/v1/customers")
      .query({ businessId: businessB })
      .set("Cookie", owner.cookie);
    expect(list.status).toBe(404);
    expect(list.body.error.code).toBe("NOT_FOUND");

    const read = await request(app)
      .get(`/api/v1/customers/${customerId}`)
      .set("Cookie", outsider.cookie);
    expect(read.status).toBe(404);

    const write = await request(app)
      .post("/api/v1/customers")
      .set("Cookie", outsider.cookie)
      .send({ businessId: businessA, name: "Hijacked", phone: "07700 900000" });
    expect(write.status).toBe(404);
  });

  it("reads one customer as a member", async () => {
    const res = await request(app)
      .get(`/api/v1/customers/${customerId}`)
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.customer.email).toBe("jane@example.com");
  });

  it("returns 404 for an unknown customer id", async () => {
    const res = await request(app)
      .get("/api/v1/customers/nonexistent")
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
