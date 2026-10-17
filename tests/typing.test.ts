import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { setRealtimeTransport, type RealtimeEvent } from "../src/realtime/hub";
import { resetTyping, setTyping, clearTyping, typingState, TYPING_TTL_MS } from "../src/realtime/typing";

/**
 * Typing indicators (FEATURES §22, §32).
 *
 * Two directions, both ephemeral and both gated exactly like the thing they
 * describe: a staff member's "I'm typing…" travels to the visitor's widget via
 * the poll response, a visitor's "I'm typing…" travels to the dashboard over
 * the socket (asserted in realtime.test.ts). Nothing is ever stored.
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
    .send({ name: `Typing ${label}`, email: `typing-${label}-${stamp}@example.com`, password });
  if (res.status !== 201) throw new Error(`register failed for ${label}: ${res.status}`);
  return { cookie: sessionCookieFrom(res), userId: res.body.data.user.id as string };
}

let owner: Actor;
let outsider: Actor;
let businessId: string;
let foreignBusinessId: string;

beforeAll(async () => {
  [owner, outsider] = await Promise.all([registerActor("owner"), registerActor("out")]);
  const business = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", owner.cookie)
    .send({ name: `Typing Test Plumbing ${stamp}`, type: "Plumber" });
  businessId = business.body.data.business.id as string;

  const foreign = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", outsider.cookie)
    .send({ name: `Typing Foreign Heating ${stamp}`, type: "Heating" });
  foreignBusinessId = foreign.body.data.business.id as string;
}, 60000);

afterEach(() => {
  resetTyping();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [owner.userId, outsider.userId] } } });
  await prisma.business.deleteMany({
    where: { id: { in: [businessId, foreignBusinessId] } },
  });
});

/** Open a website chat thread (the cheapest way to get a public token). */
async function openThread(business = businessId) {
  const res = await request(app).post(`/api/v1/chat/public/${business}`).send({
    name: "Typing Visitor",
    phone: "07700 900321",
    message: "Hello there.",
  });
  return {
    conversationId: res.body.data.conversationId as string,
    token: res.body.data.token as string,
  };
}

describe("staff typing reaches the widget (§22)", () => {
  it("flags the thread, then clears it", async () => {
    const thread = await openThread();

    const start = await request(app)
      .post(`/api/v1/conversations/${thread.conversationId}/typing`)
      .set("Cookie", owner.cookie)
      .send({});
    expect(start.status).toBe(204);
    expect(typingState(thread.conversationId).HUMAN).toBe(true);

    const polling = await request(app)
      .get(`/api/v1/chat/public/${businessId}/${thread.conversationId}/messages`)
      .set("x-chat-token", thread.token);
    expect(polling.status).toBe(200);
    expect(polling.body.data.typing).toEqual({ AI: false, HUMAN: true });

    const stop = await request(app)
      .post(`/api/v1/conversations/${thread.conversationId}/typing`)
      .set("Cookie", owner.cookie)
      .send({ active: false });
    expect(stop.status).toBe(204);

    const after = await request(app)
      .get(`/api/v1/chat/public/${businessId}/${thread.conversationId}/messages`)
      .set("x-chat-token", thread.token);
    expect(after.body.data.typing).toEqual({ AI: false, HUMAN: false });
  });

  it("refuses a member of another business (404)", async () => {
    const thread = await openThread();
    const res = await request(app)
      .post(`/api/v1/conversations/${thread.conversationId}/typing`)
      .set("Cookie", outsider.cookie)
      .send({});
    expect(res.status).toBe(404);
  });

  it("requires authentication", async () => {
    const thread = await openThread();
    const res = await request(app)
      .post(`/api/v1/conversations/${thread.conversationId}/typing`)
      .send({});
    expect(res.status).toBe(401);
  });

  it("rejects an unknown body field", async () => {
    const thread = await openThread();
    const res = await request(app)
      .post(`/api/v1/conversations/${thread.conversationId}/typing`)
      .set("Cookie", owner.cookie)
      .send({ typing: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("typing registry", () => {
  afterEach(() => setRealtimeTransport(null));

  it("flags a role and publishes the new state", () => {
    const events: RealtimeEvent[] = [];
    setRealtimeTransport({ emit: (_businessId, event) => events.push(event) });

    setTyping("biz-1", "conv-1", "HUMAN");

    expect(typingState("conv-1")).toEqual({ CUSTOMER: false, HUMAN: true, AI: false });
    expect(events.at(-1)).toMatchObject({
      type: "typing.updated",
      businessId: "biz-1",
      conversationId: "conv-1",
      typing: { CUSTOMER: false, HUMAN: true, AI: false },
    });
  });

  it("clears a role and stays quiet when there was nothing to clear", () => {
    const events: RealtimeEvent[] = [];
    setRealtimeTransport({ emit: (_businessId, event) => events.push(event) });

    clearTyping("biz-1", "conv-1", "AI");
    expect(events).toHaveLength(0);

    setTyping("biz-1", "conv-1", "AI");
    clearTyping("biz-1", "conv-1", "AI");
    expect(typingState("conv-1").AI).toBe(false);
    expect(events.at(-1)).toMatchObject({ typing: { AI: false } });
  });

  it("expires a flag once its TTL has passed", () => {
    setTyping("biz-1", "conv-1", "CUSTOMER", 10);
    expect(typingState("conv-1").CUSTOMER).toBe(true);
    expect(typingState("conv-1", Date.now() + 50).CUSTOMER).toBe(false);
  });

  it("keeps a default TTL that outlives a poll interval", () => {
    expect(TYPING_TTL_MS).toBeGreaterThanOrEqual(5000);
  });
});

describe("visitor typing reaches the dashboard (§22)", () => {
  it("flags the thread with the correct token", async () => {
    const thread = await openThread();
    const res = await request(app)
      .post(`/api/v1/chat/public/${businessId}/typing`)
      .set("x-chat-token", thread.token)
      .send({ conversationId: thread.conversationId });
    expect(res.status).toBe(204);
    expect(typingState(thread.conversationId).CUSTOMER).toBe(true);
  });

  it("can be stopped explicitly", async () => {
    const thread = await openThread();
    await request(app)
      .post(`/api/v1/chat/public/${businessId}/typing`)
      .set("x-chat-token", thread.token)
      .send({ conversationId: thread.conversationId });
    await request(app)
      .post(`/api/v1/chat/public/${businessId}/typing`)
      .set("x-chat-token", thread.token)
      .send({ conversationId: thread.conversationId, typing: false });
    expect(typingState(thread.conversationId).CUSTOMER).toBe(false);
  });

  it("refuses a thread without the token", async () => {
    const thread = await openThread();
    const res = await request(app)
      .post(`/api/v1/chat/public/${businessId}/typing`)
      .send({ conversationId: thread.conversationId });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("INVALID_CHAT_TOKEN");
  });

  it("answers 404 when the business does not own the thread", async () => {
    const thread = await openThread();
    const res = await request(app)
      .post(`/api/v1/chat/public/${foreignBusinessId}/typing`)
      .set("x-chat-token", thread.token)
      .send({ conversationId: thread.conversationId });
    expect(res.status).toBe(404);
  });
});
