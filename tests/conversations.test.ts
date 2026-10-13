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

let owner: Actor;
let staff: Actor;
let outsider: Actor;
let businessA: string;
let businessB: string;
let conversationId: string;

beforeAll(async () => {
  [owner, staff, outsider] = await Promise.all([
    registerActor("vowner"),
    registerActor("vstf"),
    registerActor("vout"),
  ]);

  const create = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", owner.cookie)
    .send({ name: "Conversation Test Plumbing", type: "Plumber" });
  if (create.status !== 201) {
    throw new Error(`business create failed: ${JSON.stringify(create.body)}`);
  }
  businessA = create.body.data.business.id as string;

  const foreign = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", outsider.cookie)
    .send({ name: "Foreign Conversation Heating", type: "Heating" });
  businessB = foreign.body.data.business.id as string;

  await prisma.businessMember.create({
    data: { businessId: businessA, userId: staff.userId, role: "STAFF" },
  });
});

afterAll(async () => {
  const ids = [owner, staff, outsider].map((a) => a.userId);
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.business.deleteMany({
    where: {
      name: { in: ["Conversation Test Plumbing", "Foreign Conversation Heating"] },
    },
  });
});

/** Create a customer in a business and return its id. */
async function seedCustomer(businessId: string, actor: Actor): Promise<string> {
  const res = await request(app)
    .post("/api/v1/customers")
    .set("Cookie", actor.cookie)
    .send({ businessId, name: "Jane Doe", phone: "07700 900123" });
  if (res.status !== 201) throw new Error(`customer create failed: ${JSON.stringify(res.body)}`);
  return res.body.data.customer.id as string;
}

describe("conversations (§19, §31–32, steps 15–16)", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/v1/conversations");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("opens a conversation for a customer (201, AI_ACTIVE)", async () => {
    const customerId = await seedCustomer(businessA, owner);
    const res = await request(app)
      .post("/api/v1/conversations")
      .set("Cookie", owner.cookie)
      .send({ businessId: businessA, customerId, channel: "WHATSAPP" });
    expect(res.status).toBe(201);
    const conversation = res.body.data.conversation;
    expect(conversation.id).toBeTruthy();
    expect(conversation.status).toBe("AI_ACTIVE");
    expect(conversation.channel).toBe("WHATSAPP");
    expect(conversation.customer.name).toBe("Jane Doe");
    expect(conversation.lastMessage).toBeNull();
    conversationId = conversation.id as string;
  });

  it("lists conversations for a member with the customer attached", async () => {
    const res = await request(app)
      .get("/api/v1/conversations")
      .query({ businessId: businessA })
      .set("Cookie", staff.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
    const [conversation] = res.body.data.conversations;
    expect(conversation.id).toBe(conversationId);
    expect(conversation.customer.name).toBe("Jane Doe");
    expect(conversation.channel).toBe("WHATSAPP");
  });

  it("keeps conversations scoped to one business (cross-tenant denied)", async () => {
    const list = await request(app)
      .get("/api/v1/conversations")
      .query({ businessId: businessB })
      .set("Cookie", owner.cookie);
    expect(list.status).toBe(404);
    expect(list.body.error.code).toBe("NOT_FOUND");

    const read = await request(app)
      .get(`/api/v1/conversations/${conversationId}`)
      .set("Cookie", outsider.cookie);
    expect(read.status).toBe(404);

    const write = await request(app)
      .patch(`/api/v1/conversations/${conversationId}/status`)
      .set("Cookie", outsider.cookie)
      .send({ status: "CLOSED" });
    expect(write.status).toBe(404);
  });

  it("lets staff take over: a reply moves the thread to HUMAN_ACTIVE", async () => {
    const res = await request(app)
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set("Cookie", staff.cookie)
      .send({ content: "Hi Jane, I'll take it from here." });
    expect(res.status).toBe(201);
    expect(res.body.data.message.sender).toBe("HUMAN");
    expect(res.body.data.conversation.status).toBe("HUMAN_ACTIVE");
    expect(res.body.data.conversation.assignedToId).toBe(staff.userId);
  });

  it("shows the reply in the detail history and as the last message", async () => {
    const detail = await request(app)
      .get(`/api/v1/conversations/${conversationId}`)
      .set("Cookie", owner.cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.data.conversation.messages).toHaveLength(1);
    expect(detail.body.data.conversation.messages[0].content).toContain("take it from here");

    const list = await request(app)
      .get("/api/v1/conversations")
      .query({ businessId: businessA, status: "HUMAN_ACTIVE" })
      .set("Cookie", owner.cookie);
    expect(list.status).toBe(200);
    expect(list.body.data.conversations[0].lastMessage.sender).toBe("HUMAN");
  });

  it("filters by status", async () => {
    const closed = await request(app)
      .get("/api/v1/conversations")
      .query({ businessId: businessA, status: "CLOSED" })
      .set("Cookie", owner.cookie);
    expect(closed.status).toBe(200);
    expect(closed.body.data.total).toBe(0);
  });

  it("rejects invalid status transitions from HUMAN_ACTIVE", async () => {
    // HUMAN_ACTIVE → HUMAN_REQUESTED is not a valid move (§19 table).
    const res = await request(app)
      .patch(`/api/v1/conversations/${conversationId}/status`)
      .set("Cookie", owner.cookie)
      .send({ status: "HUMAN_REQUESTED" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_TRANSITION");
  });

  it("walks HUMAN_ACTIVE → AI_ACTIVE → CLOSED, then rejects CLOSED → HUMAN_ACTIVE", async () => {
    const backToAi = await request(app)
      .patch(`/api/v1/conversations/${conversationId}/status`)
      .set("Cookie", owner.cookie)
      .send({ status: "AI_ACTIVE" });
    expect(backToAi.status).toBe(200);
    expect(backToAi.body.data.conversation.status).toBe("AI_ACTIVE");

    const closed = await request(app)
      .patch(`/api/v1/conversations/${conversationId}/status`)
      .set("Cookie", owner.cookie)
      .send({ status: "CLOSED" });
    expect(closed.status).toBe(200);
    expect(closed.body.data.conversation.status).toBe("CLOSED");

    const illegal = await request(app)
      .patch(`/api/v1/conversations/${conversationId}/status`)
      .set("Cookie", owner.cookie)
      .send({ status: "HUMAN_ACTIVE" });
    expect(illegal.status).toBe(400);
    expect(illegal.body.error.code).toBe("INVALID_TRANSITION");
  });

  it("returns 404 for an unknown conversation id", async () => {
    const res = await request(app)
      .get("/api/v1/conversations/nonexistent")
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects an empty message body", async () => {
    const res = await request(app)
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set("Cookie", owner.cookie)
      .send({ content: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
