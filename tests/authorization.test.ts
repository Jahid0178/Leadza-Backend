import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { findBusinessForUser, updateBusinessForUser } from "../src/repositories/business.repository";
import { findMembership } from "../src/repositories/membership.repository";

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

async function loginActor(actor: Actor): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: actor.email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return sessionCookieFrom(res);
}

// Fixture: business A with one member at each role; business B owned by an
// outsider; a fifth user promoted to PLATFORM_ADMIN.
let owner: Actor;
let admin: Actor;
let staff: Actor;
let outsider: Actor;
let platformAdmin: Actor;
let businessA: string;
let businessB: string;

beforeAll(async () => {
  [owner, admin, staff, outsider, platformAdmin] = await Promise.all([
    registerActor("owner"),
    registerActor("admin"),
    registerActor("staff"),
    registerActor("outsider"),
    registerActor("padmin"),
  ]);

  const a = await prisma.business.create({ data: { name: "Phase A Plumbing" } });
  const b = await prisma.business.create({ data: { name: "Phase B Heating" } });
  businessA = a.id;
  businessB = b.id;

  await prisma.businessMember.createMany({
    data: [
      { businessId: businessA, userId: owner.userId, role: "OWNER" },
      { businessId: businessA, userId: admin.userId, role: "ADMIN" },
      { businessId: businessA, userId: staff.userId, role: "STAFF" },
      { businessId: businessB, userId: outsider.userId, role: "OWNER" },
    ],
  });

  await prisma.user.update({
    where: { id: platformAdmin.userId },
    data: { platformRole: "PLATFORM_ADMIN" },
  });
  // The session JWT embeds platformRole at issue time — sign in again so the
  // cookie carries the promoted role.
  platformAdmin.cookie = await loginActor(platformAdmin);
});

afterAll(async () => {
  await prisma.user.deleteMany({
    where: { id: { in: [owner, admin, staff, outsider, platformAdmin].map((a) => a.userId) } },
  });
  await prisma.business.deleteMany({ where: { id: { in: [businessA, businessB] } } });
});

describe("platform admin gate (step 04, §5)", () => {
  it("rejects anonymous callers with 401", async () => {
    const res = await request(app).get("/api/v1/admin/status");
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a signed-in regular user with 403", async () => {
    const res = await request(app)
      .get("/api/v1/admin/status")
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PLATFORM_ADMIN_REQUIRED");
  });

  it("allows an authenticated PLATFORM_ADMIN", async () => {
    const res = await request(app)
      .get("/api/v1/admin/status")
      .set("Cookie", platformAdmin.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe("PLATFORM_ADMIN");
  });

  it("gates the whole namespace: unknown admin paths 403 for users, 404 for admins", async () => {
    const asUser = await request(app)
      .get("/api/v1/admin/does-not-exist")
      .set("Cookie", owner.cookie);
    expect(asUser.status).toBe(403);
    expect(asUser.body.error.code).toBe("PLATFORM_ADMIN_REQUIRED");

    const asAdmin = await request(app)
      .get("/api/v1/admin/does-not-exist")
      .set("Cookie", platformAdmin.cookie);
    expect(asAdmin.status).toBe(404);
    expect(asAdmin.body.error.code).toBe("NOT_FOUND");
  });
});

describe("business read — membership resolution (steps 05–06, §6, §13)", () => {
  it("requires authentication", async () => {
    const res = await request(app).get(`/api/v1/businesses/${businessA}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("serves the business to any verified member", async () => {
    const res = await request(app)
      .get(`/api/v1/businesses/${businessA}`)
      .set("Cookie", staff.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.business).toEqual(
      expect.objectContaining({ id: businessA, name: "Phase A Plumbing", status: "ACTIVE" }),
    );
  });

  it("returns 404 — not 403 — to non-members so ids never leak existence (§13)", async () => {
    const res = await request(app)
      .get(`/api/v1/businesses/${businessA}`)
      .set("Cookie", outsider.cookie);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("lists only the caller's own businesses", async () => {
    const mine = await request(app).get("/api/v1/businesses").set("Cookie", owner.cookie);
    expect(mine.status).toBe(200);
    const ids = mine.body.data.businesses.map((b: { id: string }) => b.id);
    expect(ids).toContain(businessA);
    expect(ids).not.toContain(businessB);

    const theirs = await request(app).get("/api/v1/businesses").set("Cookie", outsider.cookie);
    const theirIds = theirs.body.data.businesses.map((b: { id: string }) => b.id);
    expect(theirIds).toEqual([businessB]);
  });

  it("includes the caller's role and never exposes membership internals", async () => {
    const res = await request(app).get("/api/v1/businesses").set("Cookie", staff.cookie);
    const mine = res.body.data.businesses.find((b: { id: string }) => b.id === businessA);
    expect(mine.role).toBe("STAFF");
    expect(JSON.stringify(mine)).not.toContain("passwordHash");
    expect(mine).not.toHaveProperty("members");
  });
});

describe("role matrix on write (step 05, §6, §44)", () => {
  const newName = (label: string) => `Renamed ${label} ${stamp}`;

  it("OWNER can update the business", async () => {
    const res = await request(app)
      .patch(`/api/v1/businesses/${businessA}`)
      .set("Cookie", owner.cookie)
      .send({ name: newName("owner") });
    expect(res.status).toBe(200);
    expect(res.body.data.business.name).toBe(newName("owner"));
  });

  it("ADMIN can update the business", async () => {
    const res = await request(app)
      .patch(`/api/v1/businesses/${businessA}`)
      .set("Cookie", admin.cookie)
      .send({ name: newName("admin") });
    expect(res.status).toBe(200);
    expect(res.body.data.business.name).toBe(newName("admin"));
  });

  it("STAFF is refused with 403 ROLE_REQUIRED", async () => {
    const res = await request(app)
      .patch(`/api/v1/businesses/${businessA}`)
      .set("Cookie", staff.cookie)
      .send({ name: newName("staff") });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ROLE_REQUIRED");
  });

  it("a non-member never reaches the role check — 404 first", async () => {
    const res = await request(app)
      .patch(`/api/v1/businesses/${businessA}`)
      .set("Cookie", outsider.cookie)
      .send({ name: newName("outsider") });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("validates the payload after authorization (§14)", async () => {
    const empty = await request(app)
      .patch(`/api/v1/businesses/${businessA}`)
      .set("Cookie", owner.cookie)
      .send({ name: "" });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe("VALIDATION_ERROR");

    const missing = await request(app)
      .patch(`/api/v1/businesses/${businessA}`)
      .set("Cookie", owner.cookie)
      .send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("repository tenant scope (step 07, §13)", () => {
  it("findMembership resolves only within the user's own tenant", async () => {
    expect(await findMembership(owner.userId, businessA)).not.toBeNull();
    expect(await findMembership(owner.userId, businessB)).toBeNull();
    expect(await findMembership(outsider.userId, businessA)).toBeNull();
  });

  it("findBusinessForUser denies cross-tenant reads", async () => {
    expect(await findBusinessForUser(owner.userId, businessA)).not.toBeNull();
    expect(await findBusinessForUser(owner.userId, businessB)).toBeNull();
  });

  it("updateBusinessForUser affects zero rows across tenants and changes nothing", async () => {
    const before = await prisma.business.findUniqueOrThrow({ where: { id: businessB } });

    const result = await updateBusinessForUser(owner.userId, businessB, {
      name: "Hijacked name",
    });
    expect(result).toBeNull();

    const after = await prisma.business.findUniqueOrThrow({ where: { id: businessB } });
    expect(after.name).toBe(before.name);
  });
});
