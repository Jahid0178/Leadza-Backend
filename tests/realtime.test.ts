import { createServer, type Server as HttpServer } from "node:http";
import { io as ioClient, type Socket } from "socket.io-client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runLeadAgent } from "../src/agents/lead-agent";
import type { AiProvider } from "../src/agents/provider";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import {
  publishMessageCreated,
  publishRealtime,
  setRealtimeTransport,
  type RealtimeEvent,
} from "../src/realtime/hub";
import {
  attachRealtimeServer,
  closeRealtimeServer,
} from "../src/realtime/server";
import { createRealtimeToken, verifyRealtimeToken } from "../src/realtime/token";
import { resetTyping } from "../src/realtime/typing";

/**
 * Realtime layer (IMPLEMENTATION_PLAN step 38).
 *
 * The socket itself is exercised for real: the suite starts an HTTP server
 * with the app and the socket.io server attached, connects authenticated
 * socket.io clients, and asserts that a staff reply written through the API
 * reaches the browser live — and that a member of another business never
 * receives it.
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
  const session = cookies.find((cookie) =>
    cookie.startsWith("authjs.session-token="),
  );
  if (!session) throw new Error("expected an authjs.session-token cookie");
  return session.split(";")[0] ?? "";
}

async function registerActor(label: string): Promise<Actor> {
  const res = await request(app)
    .post("/api/v1/auth/register")
    .send({
      name: `Realtime ${label}`,
      email: `realtime-${label}-${stamp}@example.com`,
      password,
    });
  if (res.status !== 201) {
    throw new Error(`register failed for ${label}: ${res.status}`);
  }
  return {
    cookie: sessionCookieFrom(res),
    userId: res.body.data.user.id as string,
  };
}

let httpServer: HttpServer;
let baseUrl: string;
let owner: Actor;
let outsider: Actor;
let businessA: string;

beforeAll(async () => {
  [owner, outsider] = await Promise.all([
    registerActor("owner"),
    registerActor("out"),
  ]);

  const created = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", owner.cookie)
    .send({ name: "Realtime Test Plumbing", type: "Plumber" });
  if (created.status !== 201) {
    throw new Error(`business create failed: ${JSON.stringify(created.body)}`);
  }
  businessA = created.body.data.business.id as string;

  // The API and the socket server share one HTTP server, exactly like boot.
  httpServer = createServer(app);
  attachRealtimeServer(httpServer);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });

  const address = httpServer.address();
  const port =
    address && typeof address === "object" ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await closeRealtimeServer();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  resetTyping();
  await prisma.user.deleteMany({
    where: { id: { in: [owner.userId, outsider.userId] } },
  });
  await prisma.business.deleteMany({
    where: { name: "Realtime Test Plumbing" },
  });
});

/** A socket.io client pointed at the test server. */
function connectSocket(token?: string): Socket {
  return ioClient(baseUrl, {
    path: "/realtime",
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
    auth: token ? { token } : {},
  });
}

/** Resolve with the next payload for `event`, or reject on timeout. */
function once<T>(socket: Socket, event: string, timeoutMs = 8000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);

    function handler(payload: T) {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }

    socket.on(event, handler);
  });
}

describe("realtime tokens (§38)", () => {
  it("mints a token that verifies back to the same user", async () => {
    const token = await createRealtimeToken(owner.userId);
    const verified = await verifyRealtimeToken(token);
    expect(verified).toEqual({ userId: owner.userId });
  });

  it("rejects missing, forged and expired tokens", async () => {
    expect(await verifyRealtimeToken(undefined)).toBeNull();
    expect(await verifyRealtimeToken("not-a-token")).toBeNull();

    // Expired well beyond the decoder's 15s clock tolerance.
    const expired = await createRealtimeToken(owner.userId, -60);
    expect(await verifyRealtimeToken(expired)).toBeNull();
  });

  it("requires authentication on POST /api/v1/realtime/token", async () => {
    const anonymous = await request(app).post("/api/v1/realtime/token");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("returns a socket token to a signed-in member", async () => {
    const res = await request(app)
      .post("/api/v1/realtime/token")
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.data.expiresInSeconds).toBeGreaterThan(0);
    expect(await verifyRealtimeToken(res.body.data.token)).toEqual({
      userId: owner.userId,
    });
  });
});

describe("realtime hub (§38)", () => {
  it("forwards a published event to the transport", () => {
    const seen: RealtimeEvent[] = [];
    setRealtimeTransport({ emit: (_businessId, event) => seen.push(event) });

    publishMessageCreated("biz-1", {
      id: "msg-1",
      conversationId: "conv-1",
      sender: "CUSTOMER",
      content: "Hello",
      channel: "WEBSITE",
      aiGenerated: false,
      externalMessageId: null,
      createdAt: new Date("2026-01-01T10:00:00.000Z"),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: "message.created",
      businessId: "biz-1",
      message: { id: "msg-1", createdAt: "2026-01-01T10:00:00.000Z" },
    });

    setRealtimeTransport(null);
  });

  it("is a no-op on publish errors and when nothing is attached", () => {
    expect(() =>
      publishRealtime({
        type: "conversation.created",
        businessId: "biz-1",
        conversationId: "conv-1",
      }),
    ).not.toThrow();

    setRealtimeTransport({
      emit() {
        throw new Error("socket transport is down");
      },
    });
    expect(() =>
      publishRealtime({
        type: "conversation.created",
        businessId: "biz-1",
        conversationId: "conv-1",
      }),
    ).not.toThrow();

    setRealtimeTransport(null);
  });
});

/** A provider that always answers with the same canned text. */
function fakeProvider(text: string): AiProvider {
  return {
    name: "fake",
    async complete() {
      return {
        text,
        model: "fake-model",
        usage: { inputTokens: 8, outputTokens: 12, totalTokens: 20 },
      };
    },
  };
}

describe("live socket (§38)", () => {
  // The hub tests above deliberately detach the transport; re-arm the real one
  // (attach is idempotent, so this never spawns a second socket.io server).
  beforeAll(() => {
    attachRealtimeServer(httpServer);
  });

  it("rejects a socket without a valid token", async () => {
    const socket = connectSocket();
    const error = await once<Error>(socket, "connect_error");
    expect(error.message).toBe("UNAUTHORIZED");
    socket.close();
  });

  it("subscribes a member and streams a staff reply written through the API", async () => {
    const socket = connectSocket(await createRealtimeToken(owner.userId));
    const ready = await once<{ businessIds: string[] }>(socket, "ready");
    expect(ready.businessIds).toContain(businessA);

    // Open a thread through the public API on the same server…
    const customer = await request(httpServer)
      .post("/api/v1/customers")
      .set("Cookie", owner.cookie)
      .send({ businessId: businessA, name: "Live Customer", phone: "07700 900456" });
    expect(customer.status).toBe(201);

    const conversation = await request(httpServer)
      .post("/api/v1/conversations")
      .set("Cookie", owner.cookie)
      .send({
        businessId: businessA,
        customerId: customer.body.data.customer.id,
        channel: "WEBSITE",
      });
    expect(conversation.status).toBe(201);
    const conversationId = conversation.body.data.conversation.id as string;

    // …then reply, and expect the socket to already have told us.
    const delivered = once<{
      conversationId: string;
      message: { sender: string; content: string };
    }>(socket, "message.created");

    const reply = await request(httpServer)
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set("Cookie", owner.cookie)
      .send({ content: "Hello from staff" });
    expect(reply.status).toBe(201);

    const event = await delivered;
    expect(event.conversationId).toBe(conversationId);
    expect(event.message.sender).toBe("HUMAN");
    expect(event.message.content).toBe("Hello from staff");

    socket.close();
  });

  it("streams typing state for the open conversation", async () => {
    const socket = connectSocket(await createRealtimeToken(owner.userId));
    await once<{ businessIds: string[] }>(socket, "ready");

    const customer = await prisma.customer.create({
      data: { businessId: businessA, name: "Typing Customer" },
    });
    const conversation = await prisma.conversation.create({
      data: { businessId: businessA, customerId: customer.id, channel: "WEBSITE" },
    });

    const delivered = once<{
      conversationId: string;
      typing: { HUMAN: boolean };
    }>(socket, "typing.updated");

    const res = await request(httpServer)
      .post(`/api/v1/conversations/${conversation.id}/typing`)
      .set("Cookie", owner.cookie)
      .send({});
    expect(res.status).toBe(204);

    const event = await delivered;
    expect(event.conversationId).toBe(conversation.id);
    expect(event.typing.HUMAN).toBe(true);

    socket.close();
  });

  it("publishes the AI agent's reply", async () => {
    const events: RealtimeEvent[] = [];
    setRealtimeTransport({ emit: (_businessId, event) => events.push(event) });

    const customer = await prisma.customer.create({
      data: { businessId: businessA, name: "AI Live Customer" },
    });
    const conversation = await prisma.conversation.create({
      data: { businessId: businessA, customerId: customer.id, channel: "WEBSITE" },
    });
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender: "CUSTOMER",
        content: "My boiler is leaking",
      },
    });

    const result = await runLeadAgent(conversation.id, {
      provider: fakeProvider("Thanks for the details — I have noted the leak."),
    });
    expect(result.status).toBe("replied");

    const aiEvents = events.filter(
      (event) => event.type === "message.created" && event.message.sender === "AI",
    );
    expect(aiEvents).toHaveLength(1);
    expect(aiEvents[0]).toMatchObject({
      businessId: businessA,
      conversationId: conversation.id,
      message: { aiGenerated: true, content: "Thanks for the details — I have noted the leak." },
    });

    // Leave the real transport attached for anything that runs later.
    attachRealtimeServer(httpServer);
  });

  it("never delivers another business's events", async () => {
    // The outsider belongs to no business at all → no rooms joined.
    const socket = connectSocket(await createRealtimeToken(outsider.userId));
    const ready = await once<{ businessIds: string[] }>(socket, "ready");
    expect(ready.businessIds).not.toContain(businessA);

    const leaked: RealtimeEvent[] = [];
    socket.on("message.created", (event: RealtimeEvent) => leaked.push(event));

    publishMessageCreated(businessA, {
      id: "msg-tenant-leak",
      conversationId: "conv-tenant-leak",
      sender: "CUSTOMER",
      content: "Should never arrive",
      channel: "WEBSITE",
      aiGenerated: false,
      externalMessageId: null,
      createdAt: new Date(),
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(leaked).toHaveLength(0);
    socket.close();
  });
});
