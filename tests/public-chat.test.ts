import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { WIDGET_SCRIPT } from "../src/widget/script";
import { prisma } from "../src/lib/prisma";

/**
 * Public website chat tests (FEATURES §22, IMPLEMENTATION_PLAN step 19).
 *
 * The conversational embed is the API's second unauthenticated write path, so
 * these tests pin its security boundary: the thread access token gates reads
 * and continuations, and a conversation id from another business is refused.
 * The AI reply itself arrives via the background queue, so tests simulate it
 * by inserting an AI message and asserting the poll endpoint surfaces it.
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
  const email = `${label}-${stamp}@example.com`;
  const res = await request(app)
    .post("/api/v1/auth/register")
    .send({ name: `Actor ${label}`, email, password });
  if (res.status !== 201) throw new Error(`register failed for ${label}: ${res.status}`);
  return { cookie: sessionCookieFrom(res), userId: res.body.data.user.id as string };
}

async function createBusiness(actor: Actor, name: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", actor.cookie)
    .send({ name });
  if (res.status !== 201) throw new Error(`business create failed: ${res.status}`);
  return res.body.data.business.id as string;
}

let owner: Actor;
let otherOwner: Actor;
let businessId: string;
let otherBusinessId: string;
let suspendedBusinessId: string;

beforeAll(async () => {
  [owner, otherOwner] = await Promise.all([registerActor("cowner"), registerActor("cother")]);
  businessId = await createBusiness(owner, `Chat Test Plumbing ${stamp}`);
  otherBusinessId = await createBusiness(otherOwner, `Chat Other Heating ${stamp}`);
  suspendedBusinessId = await createBusiness(otherOwner, `Chat Suspended HVAC ${stamp}`);
  await prisma.business.update({
    where: { id: suspendedBusinessId },
    data: { status: "SUSPENDED" },
  });
}, 60000);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [owner.userId, otherOwner.userId] } } });
  await prisma.business.deleteMany({
    where: { id: { in: [businessId, otherBusinessId, suspendedBusinessId] } },
  });
});

/**
 * Open a thread and return its id + token. Starting a chat requires the
 * visitor's details (step 19a), so they are sent unless a test overrides them.
 */
async function openThread(
  business: string,
  body: Record<string, unknown> = {},
): Promise<{ conversationId: string; token: string; status: number }> {
  const payload = {
    name: "Test Visitor",
    phone: "07700 900123",
    message: "My boiler is leaking.",
    ...body,
  };
  const res = await request(app).post(`/api/v1/chat/public/${business}`).send(payload);
  return {
    status: res.status,
    conversationId: res.body.data?.conversationId as string,
    token: res.body.data?.token as string,
  };
}

describe("public website chat (§22, step 19)", () => {
  it("reports AI availability + business name for the widget", async () => {
    const res = await request(app).get(`/api/v1/chat/public/${businessId}/status`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.aiEnabled).toBe("boolean");
    expect(res.body.data.businessName).toContain("Chat Test Plumbing");
  });

  it("opens a thread: customer + lead + AI_ACTIVE conversation + message", async () => {
    const res = await request(app)
      .post(`/api/v1/chat/public/${businessId}`)
      .send({
        message: "My boiler is leaking, can you help?",
        name: "Sam Rivers",
        phone: "07700 900777",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.conversationId).toBeTruthy();
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.status).toBe("AI_ACTIVE");

    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: res.body.data.conversationId as string },
      include: { messages: true, lead: true, customer: true },
    });
    expect(conversation.channel).toBe("WEBSITE");
    expect(conversation.status).toBe("AI_ACTIVE");
    expect(conversation.publicToken).toBe(res.body.data.token);
    expect(conversation.lead?.source).toBe("WEBSITE");
    expect(conversation.customer.name).toBe("Sam Rivers");
    expect(conversation.customer.phone).toBe("07700 900777");
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]?.sender).toBe("CUSTOMER");
    expect(conversation.messages[0]?.content).toContain("boiler is leaking");
  });

  it("requires a name and a way to reply before a chat starts", async () => {
    const noName = await request(app)
      .post(`/api/v1/chat/public/${businessId}`)
      .send({ message: "Hello" });
    expect(noName.status).toBe(400);
    expect(noName.body.error.code).toBe("VALIDATION_ERROR");
    expect(noName.body.error.message).toContain("name");

    const noContact = await request(app)
      .post(`/api/v1/chat/public/${businessId}`)
      .send({ message: "Hello", name: "Jane Doe" });
    expect(noContact.status).toBe(400);
    expect(noContact.body.error.code).toBe("VALIDATION_ERROR");
    expect(noContact.body.error.message).toContain("phone number or email");

    // Nothing was stored for either attempt.
    const conversations = await prisma.conversation.count({
      where: { businessId, customer: { name: { in: ["Jane Doe"] } } },
    });
    expect(conversations).toBe(0);
  });

  it("does not ask for details again when continuing a thread", async () => {
    const thread = await openThread(businessId, { message: "First message" });
    const res = await request(app)
      .post(`/api/v1/chat/public/${businessId}`)
      .set("x-chat-token", thread.token)
      .send({ message: "Follow-up without repeating myself", conversationId: thread.conversationId });
    expect(res.status).toBe(200);
  });

  it("records contact details when the visitor provides them", async () => {
    const res = await request(app)
      .post(`/api/v1/chat/public/${businessId}`)
      .send({ message: "Hello", name: "Jane Doe", phone: "07700 900555" });
    expect(res.status).toBe(201);

    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: res.body.data.conversationId as string },
      include: { customer: true },
    });
    expect(conversation.customer.name).toBe("Jane Doe");
    expect(conversation.customer.phone).toBe("07700 900555");
  });

  it("continues a thread given a valid token", async () => {
    const thread = await openThread(businessId, { message: "First message" });
    expect(thread.status).toBe(201);

    const res = await request(app)
      .post(`/api/v1/chat/public/${businessId}`)
      .set("x-chat-token", thread.token)
      .send({ message: "Second message", conversationId: thread.conversationId });

    expect(res.status).toBe(200);
    expect(res.body.data.conversationId).toBe(thread.conversationId);

    const messages = await prisma.message.findMany({
      where: { conversationId: thread.conversationId },
      orderBy: { createdAt: "asc" },
    });
    expect(messages.map((m) => m.content)).toEqual(["First message", "Second message"]);
  });

  it("refuses to continue a thread with the wrong token", async () => {
    const thread = await openThread(businessId, { message: "Mine" });
    const res = await request(app)
      .post(`/api/v1/chat/public/${businessId}`)
      .set("x-chat-token", "not-the-token")
      .send({ message: "Hijack", conversationId: thread.conversationId });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("INVALID_CHAT_TOKEN");
  });

  it("refuses a conversation id that belongs to another business", async () => {
    const other = await openThread(otherBusinessId, { message: "Other tenant" });

    const res = await request(app)
      .post(`/api/v1/chat/public/${businessId}`)
      .set("x-chat-token", other.token)
      .send({ message: "Cross tenant", conversationId: other.conversationId });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("INVALID_CHAT_TOKEN");
  });

  it("answers 404 for an unknown business", async () => {
    const res = await request(app)
      .post("/api/v1/chat/public/no-such-business")
      .send({ message: "Hello?", name: "Lost Visitor", phone: "07700 900999" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects a suspended business with 403", async () => {
    const res = await request(app)
      .post(`/api/v1/chat/public/${suspendedBusinessId}`)
      .send({ message: "Hello?", name: "Suspended Visitor", phone: "07700 900998" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("BUSINESS_SUSPENDED");
  });

  it("drops honeypot submissions silently", async () => {
    const res = await request(app)
      .post(`/api/v1/chat/public/${businessId}`)
      .send({ message: "spam", website: "https://spam.example" });
    expect(res.status).toBe(201);
    expect(res.body.data.accepted).toBe(true);
    expect(res.body.data.conversationId).toBeUndefined();
  });

  it("validates the message body", async () => {
    const res = await request(app)
      .post(`/api/v1/chat/public/${businessId}`)
      .send({ message: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("chat polling (§22)", () => {
  it("returns the thread's messages and surfaces the AI reply", async () => {
    const thread = await openThread(businessId, { message: "Is anyone there?" });

    const before = await request(app)
      .get(`/api/v1/chat/public/${businessId}/${thread.conversationId}/messages`)
      .set("x-chat-token", thread.token);
    expect(before.status).toBe(200);
    expect(before.body.data.messages).toHaveLength(1);
    expect(before.body.data.messages[0].sender).toBe("CUSTOMER");

    // Simulate the background agent storing its reply.
    await prisma.message.create({
      data: {
        conversationId: thread.conversationId,
        sender: "AI",
        content: "Thanks — what postcode are you in?",
        channel: "WEBSITE",
        aiGenerated: true,
      },
    });

    const after = await request(app)
      .get(`/api/v1/chat/public/${businessId}/${thread.conversationId}/messages`)
      .set("x-chat-token", thread.token);
    expect(after.status).toBe(200);
    const senders = after.body.data.messages.map((m: { sender: string }) => m.sender);
    expect(senders).toEqual(["CUSTOMER", "AI"]);
    expect(after.body.data.status).toBe("AI_ACTIVE");
  });

  it("refuses to read a thread without the token", async () => {
    const thread = await openThread(businessId, { message: "Private" });
    const res = await request(app).get(
      `/api/v1/chat/public/${businessId}/${thread.conversationId}/messages`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("INVALID_CHAT_TOKEN");
  });

  it("returns 404 when the business does not own the thread", async () => {
    const other = await openThread(otherBusinessId, { message: "Elsewhere" });
    const res = await request(app)
      .get(`/api/v1/chat/public/${businessId}/${other.conversationId}/messages`)
      .set("x-chat-token", other.token);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

describe("widget script (§22, step 19)", () => {
  it("serves the widget with both chat and form fallback", async () => {
    const res = await request(app).get("/widget.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("javascript");
    expect(res.text).toContain("data-business");
    expect(res.text).toContain("/api/v1/chat/public/");
    expect(res.text).toContain("/api/v1/leads/public/");
  });

  it("asks for the visitor's details before the chat starts", () => {
    // The pre-chat step exists and carries the identity fields the API requires.
    expect(WIDGET_SCRIPT).toContain("ldz-detailsview");
    expect(WIDGET_SCRIPT).toContain("Start chat");
    expect(WIDGET_SCRIPT).toContain('{ name: "name", type: "text", placeholder: "Your name *"');
    expect(WIDGET_SCRIPT).toContain('{ name: "phone", type: "tel"');
    expect(WIDGET_SCRIPT).toContain('{ name: "email", type: "email"');
    // The chat composer is only reachable once the thread exists.
    expect(WIDGET_SCRIPT).toContain('setView("chat")');
  });

  it("is syntactically valid JavaScript", () => {
    // Parsing only — the script references document at runtime.
    expect(() => new Function(WIDGET_SCRIPT)).not.toThrow();
  });

  it("allows cross-origin chat submissions (embed CORS)", async () => {
    const preflight = await request(app)
      .options(`/api/v1/chat/public/${businessId}`)
      .set("Origin", "https://customer-site.example")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,x-chat-token");
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(
      "https://customer-site.example",
    );

    const post = await request(app)
      .post(`/api/v1/chat/public/${businessId}`)
      .set("Origin", "https://customer-site.example")
      .send({ message: "Cross-origin hello", name: "Cors Visitor", email: "cors@example.com" });
    expect(post.status).toBe(201);
    expect(post.headers["access-control-allow-origin"]).toBe(
      "https://customer-site.example",
    );
  });
});
