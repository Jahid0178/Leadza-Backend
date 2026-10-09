import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { findMembership } from "../src/repositories/membership.repository";
import { markOnboardingCompleteForUser } from "../src/repositories/business.repository";

const app = createApp();

const stamp = Date.now();
const password = "s3cure-pass-1";

function sessionCookieFrom(res: request.Response): string {
  const header = res.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  const session = cookies.find((cookie) => cookie.startsWith("authjs.session-token="));
  if (!session) throw new Error("expected an authjs.session-token cookie");
  return session.split(";")[0] ?? "";
}

async function registerActor(label: string) {
  const email = `${label}-${stamp}@example.com`;
  const res = await request(app)
    .post("/api/v1/auth/register")
    .send({ name: `Actor ${label}`, email, password });
  if (res.status !== 201) throw new Error(`register failed: ${res.status}`);
  return { email, cookie: sessionCookieFrom(res), userId: res.body.data.user.id as string };
}

let owner: Actor2;
let staff: Actor2;
let businessId: string;

interface Actor2 {
  email: string;
  cookie: string;
  userId: string;
}

beforeAll(async () => {
  [owner, staff] = await Promise.all([registerActor("own"), registerActor("stf")]);

  // Staff membership is not provisioned by any API yet — seed it directly (§6).
  const created = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", owner.cookie)
    .send({ name: "Onboard Plumbing", type: "Plumber" });
  if (created.status !== 201) throw new Error(`create failed: ${JSON.stringify(created.body)}`);
  businessId = created.body.data.business.id as string;

  await prisma.businessMember.create({
    data: { businessId, userId: staff.userId, role: "STAFF" },
  });
});

afterAll(async () => {
  await prisma.user.deleteMany({
    where: { id: { in: [owner, staff].map((a) => a.userId) } },
  });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

describe("create business (§9)", () => {
  it("requires authentication", async () => {
    const res = await request(app)
      .post("/api/v1/businesses")
      .send({ name: "Anonymous Traders" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a too-short name before touching the database (§14)", async () => {
    const res = await request(app)
      .post("/api/v1/businesses")
      .set("Cookie", owner.cookie)
      .send({ name: "X" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("creates a business with an OWNER membership and no onboarding flag", async () => {
    const res = await request(app)
      .post("/api/v1/businesses")
      .set("Cookie", owner.cookie)
      .send({ name: `Second Biz ${stamp}`, type: "Electrician" });
    expect(res.status).toBe(201);
    const business = res.body.data.business;
    expect(business.role).toBe("OWNER");
    expect(business.type).toBe("Electrician");
    expect(business.onboardingCompletedAt).toBeNull();

    const membership = await findMembership(owner.userId, business.id);
    expect(membership?.role).toBe("OWNER");

    // Keep the fixture clean — the onboarding tests target businessId only.
    await prisma.business.delete({ where: { id: business.id } });
  });
});

describe("business profile PATCH (§8, step 08)", () => {
  it("saves the full profile for an OWNER", async () => {
    const res = await request(app)
      .patch(`/api/v1/businesses/${businessId}`)
      .set("Cookie", owner.cookie)
      .send({
        name: "Onboard Plumbing Ltd",
        type: "Plumber",
        website: "https://onboard-plumbing.example",
        phone: "0118 496 0001",
        email: "hello@onboard-plumbing.example",
        address: "1 High Street, Reading",
        description: "Emergency plumbing across Berkshire.",
      });
    expect(res.status).toBe(200);
    expect(res.body.data.business).toEqual(
      expect.objectContaining({
        name: "Onboard Plumbing Ltd",
        website: "https://onboard-plumbing.example",
        address: "1 High Street, Reading",
        description: "Emergency plumbing across Berkshire.",
      }),
    );
  });

  it("rejects an invalid website or email", async () => {
    const website = await request(app)
      .patch(`/api/v1/businesses/${businessId}`)
      .set("Cookie", owner.cookie)
      .send({ website: "not-a-url" });
    expect(website.status).toBe(400);
    expect(website.body.error.code).toBe("VALIDATION_ERROR");

    const email = await request(app)
      .patch(`/api/v1/businesses/${businessId}`)
      .set("Cookie", owner.cookie)
      .send({ email: "not-an-email" });
    expect(email.status).toBe(400);
    expect(email.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("clears a field when sent an explicit null", async () => {
    const res = await request(app)
      .patch(`/api/v1/businesses/${businessId}`)
      .set("Cookie", owner.cookie)
      .send({ website: null });
    expect(res.status).toBe(200);
    expect(res.body.data.business.website).toBeNull();
  });

  it("rejects an empty or unknown-only patch", async () => {
    const empty = await request(app)
      .patch(`/api/v1/businesses/${businessId}`)
      .set("Cookie", owner.cookie)
      .send({});
    expect(empty.status).toBe(400);

    const unknown = await request(app)
      .patch(`/api/v1/businesses/${businessId}`)
      .set("Cookie", owner.cookie)
      .send({ bogus: "field" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses STAFF with 403 and non-members with 404", async () => {
    const asStaff = await request(app)
      .patch(`/api/v1/businesses/${businessId}`)
      .set("Cookie", staff.cookie)
      .send({ name: `Staff Rename ${stamp}` });
    expect(asStaff.status).toBe(403);
    expect(asStaff.body.error.code).toBe("ROLE_REQUIRED");

    const outsider = await registerActor("out");
    const asOutsider = await request(app)
      .patch(`/api/v1/businesses/${businessId}`)
      .set("Cookie", outsider.cookie)
      .send({ name: `Outsider Rename ${stamp}` });
    expect(asOutsider.status).toBe(404);
    await prisma.user.delete({ where: { id: outsider.userId } });
  });
});

describe("onboarding completion (§9, step 08)", () => {
  it("is 404 for non-members and 403 for STAFF", async () => {
    const outsider = await registerActor("oc");
    const asOutsider = await request(app)
      .post(`/api/v1/businesses/${businessId}/onboarding/complete`)
      .set("Cookie", outsider.cookie);
    expect(asOutsider.status).toBe(404);
    await prisma.user.delete({ where: { id: outsider.userId } });

    const asStaff = await request(app)
      .post(`/api/v1/businesses/${businessId}/onboarding/complete`)
      .set("Cookie", staff.cookie);
    expect(asStaff.status).toBe(403);
    expect(asStaff.body.error.code).toBe("ROLE_REQUIRED");
  });

  it("sets the flag for the OWNER and is safe to repeat", async () => {
    const first = await request(app)
      .post(`/api/v1/businesses/${businessId}/onboarding/complete`)
      .set("Cookie", owner.cookie);
    expect(first.status).toBe(200);
    expect(first.body.data.business.onboardingCompletedAt).not.toBeNull();

    const repeat = await request(app)
      .post(`/api/v1/businesses/${businessId}/onboarding/complete`)
      .set("Cookie", owner.cookie);
    expect(repeat.status).toBe(200);

    const read = await request(app)
      .get(`/api/v1/businesses/${businessId}`)
      .set("Cookie", owner.cookie);
    expect(read.body.data.business.onboardingCompletedAt).not.toBeNull();
  });

  it("tenant-scoped write refuses a foreign user and changes nothing", async () => {
    const before = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
    const outsider = await registerActor("oc2");
    const result = await markOnboardingCompleteForUser(outsider.userId, businessId);
    expect(result).toBeNull();

    const after = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
    expect(after.onboardingCompletedAt?.getTime()).toBe(before.onboardingCompletedAt?.getTime());
    await prisma.user.delete({ where: { id: outsider.userId } });
  });
});
