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
    throw new Error(`register failed for ${label}: ${res.status}`);
  }
  return { email, cookie: sessionCookieFrom(res), userId: res.body.data.user.id as string };
}

let owner: Actor;
let suspendedOwner: Actor;
let businessA: string;
let suspendedBusiness: string;

/** A realistic enquiry body — reused to trigger the duplicate path. */
function enquiry(extra: Record<string, unknown> = {}) {
  return {
    name: "Website Visitor",
    phone: "07700 900777",
    message: "My boiler is leaking and the pressure keeps dropping.",
    ...extra,
  };
}

beforeAll(async () => {
  [owner, suspendedOwner] = await Promise.all([
    registerActor("wowner"),
    registerActor("wsusp"),
  ]);

  const create = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", owner.cookie)
    .send({ name: "Widget Test Plumbing", type: "Plumber" });
  if (create.status !== 201) throw new Error("business create failed");
  businessA = create.body.data.business.id as string;

  await request(app)
    .post("/api/v1/services")
    .set("Cookie", owner.cookie)
    .send({ businessId: businessA, name: "Boiler Repair", price: 90, priceType: "FROM" });
  await request(app)
    .post("/api/v1/services")
    .set("Cookie", owner.cookie)
    .send({ businessId: businessA, name: "Roofing", price: 200, priceType: "FROM", active: false });

  const foreign = await request(app)
    .post("/api/v1/businesses")
    .set("Cookie", suspendedOwner.cookie)
    .send({ name: "Suspended Widget Heating", type: "Heating" });
  suspendedBusiness = foreign.body.data.business.id as string;
  // Suspension has no user-facing API until step 28 — flip it directly.
  await prisma.business.update({
    where: { id: suspendedBusiness },
    data: { status: "SUSPENDED" },
  });
}, 60000);

afterAll(async () => {
  const ids = [owner, suspendedOwner].map((a) => a.userId);
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.business.deleteMany({
    where: { name: { in: ["Widget Test Plumbing", "Suspended Widget Heating"] } },
  });
});

describe("public lead capture (§21, step 18)", () => {
  it("answers 404 for an unknown business", async () => {
    const res = await request(app)
      .post("/api/v1/leads/public/no-such-business")
      .send(enquiry());
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects a suspended business with 403", async () => {
    const res = await request(app)
      .post(`/api/v1/leads/public/${suspendedBusiness}`)
      .send(enquiry());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("BUSINESS_SUSPENDED");
  });

  it("captures an enquiry: customer + NEW lead + AI_ACTIVE conversation", async () => {
    const res = await request(app)
      .post(`/api/v1/leads/public/${businessA}`)
      .send(enquiry());
    expect(res.status).toBe(201);
    expect(res.body.data.accepted).toBe(true);
    expect(res.body.data.duplicate).toBe(false);
    expect(res.body.data.lead.status).toBe("NEW");
    expect(res.body.data.conversation.status).toBe("AI_ACTIVE");

    // The dashboard pipeline sees it: lead on the list with the message…
    const leads = await request(app)
      .get("/api/v1/leads")
      .query({ businessId: businessA })
      .set("Cookie", owner.cookie);
    const lead = leads.body.data.leads.find(
      (l: { id: string }) => l.id === res.body.data.lead.id,
    );
    expect(lead).toBeTruthy();
    expect(lead.customerMessage).toBe(enquiry().message);
    expect(lead.source).toBe("WEBSITE");
    expect(lead.customer.phone).toBe("07700 900777");

    // …and a WEBSITE conversation linked to that lead (§21 flow).
    const conversations = await request(app)
      .get("/api/v1/conversations")
      .query({ businessId: businessA })
      .set("Cookie", owner.cookie);
    const conversation = conversations.body.data.conversations.find(
      (c: { id: string }) => c.id === res.body.data.conversation.id,
    );
    expect(conversation).toBeTruthy();
    expect(conversation.channel).toBe("WEBSITE");
    expect(conversation.status).toBe("AI_ACTIVE");

    // The enquiry itself is the thread's first message. Without a Message row
    // the dashboard thread rendered empty and the agent saw "no customer
    // message" and stayed silent — the enquiry was invisible on both sides.
    const detail = await request(app)
      .get(`/api/v1/conversations/${res.body.data.conversation.id}`)
      .set("Cookie", owner.cookie);
    expect(detail.status).toBe(200);
    const [firstMessage] = detail.body.data.conversation.messages;
    expect(detail.body.data.conversation.messages).toHaveLength(1);
    expect(firstMessage.sender).toBe("CUSTOMER");
    expect(firstMessage.content).toBe(enquiry().message);
  });

  it("links an active service by name and ignores unknown names", async () => {
    const matched = await request(app)
      .post(`/api/v1/leads/public/${businessA}`)
      .send(enquiry({ phone: "07700 900778", serviceName: "Boiler Repair" }));
    expect(matched.status).toBe(201);

    const leads = await request(app)
      .get("/api/v1/leads")
      .query({ businessId: businessA })
      .set("Cookie", owner.cookie);
    const lead = leads.body.data.leads.find(
      (l: { id: string }) => l.id === matched.body.data.lead.id,
    );
    expect(lead.service?.name).toBe("Boiler Repair");

    // A name that matches nothing stays a valid lead with no service —
    // the AI clarifies it later; the form never invents one (§25).
    const unmatched = await request(app)
      .post(`/api/v1/leads/public/${businessA}`)
      .send(enquiry({ phone: "07700 900779", serviceName: "Quantum untangling" }));
    expect(unmatched.status).toBe(201);
    const leads2 = await request(app)
      .get("/api/v1/leads")
      .query({ businessId: businessA })
      .set("Cookie", owner.cookie);
    const lead2 = leads2.body.data.leads.find(
      (l: { id: string }) => l.id === unmatched.body.data.lead.id,
    );
    expect(lead2.service).toBeNull();
  });

  it("returns the existing lead for a duplicate submission", async () => {
    // Same phone + same message as the first capture, inside the window.
    const res = await request(app)
      .post(`/api/v1/leads/public/${businessA}`)
      .send(enquiry());
    expect(res.status).toBe(200);
    expect(res.body.data.duplicate).toBe(true);
    expect(res.body.data.lead.id).toBeTruthy();
  });

  it("keeps one customer for the same phone number", async () => {
    // Same phone, different message → new lead, same customer row.
    const res = await request(app)
      .post(`/api/v1/leads/public/${businessA}`)
      .send(enquiry({ message: "Also the kitchen tap is dripping." }));
    expect(res.status).toBe(201);

    const customers = await request(app)
      .get("/api/v1/customers")
      .query({ businessId: businessA })
      .set("Cookie", owner.cookie);
    const matching = customers.body.data.customers.filter(
      (c: { phone: string | null }) => c.phone === "07700 900777",
    );
    expect(matching).toHaveLength(1);
  });

  it("drops honeypot submissions silently", async () => {
    const before = await request(app)
      .get("/api/v1/leads")
      .query({ businessId: businessA })
      .set("Cookie", owner.cookie);
    const totalBefore = before.body.data.total;

    const res = await request(app)
      .post(`/api/v1/leads/public/${businessA}`)
      .send(enquiry({ phone: "07700 900780", website: "https://spam.example" }));
    // Bots get a plausible success — no error to adapt to — but nothing
    // is stored and no lead/conversation ids leak back.
    expect(res.status).toBe(201);
    expect(res.body.data.accepted).toBe(true);
    expect(res.body.data.lead).toBeUndefined();

    const after = await request(app)
      .get("/api/v1/leads")
      .query({ businessId: businessA })
      .set("Cookie", owner.cookie);
    expect(after.body.data.total).toBe(totalBefore);
  });

  it("validates the payload (contact required)", async () => {
    const res = await request(app)
      .post(`/api/v1/leads/public/${businessA}`)
      .send({ name: "No Contact", message: "Hello" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.message).toContain("phone");
  });

  it("serves the embeddable widget script", async () => {
    const res = await request(app).get("/widget.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("javascript");
    // The snippet contract from §21: data-business selects the business.
    expect(res.text).toContain("data-business");
    expect(res.text).toContain("/api/v1/leads/public/");
  });

  it("allows cross-origin submissions (embed CORS)", async () => {
    const preflight = await request(app)
      .options(`/api/v1/leads/public/${businessA}`)
      .set("Origin", "https://customer-site.example")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type");
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(
      "https://customer-site.example",
    );

    // The actual POST must carry the same reflected origin — the browser
    // enforces it on the response, and a second cors() middleware later in
    // the chain used to overwrite it (caught by the e2e, not by supertest).
    const post = await request(app)
      .post(`/api/v1/leads/public/${businessA}`)
      .set("Origin", "https://customer-site.example")
      .send(enquiry({ phone: "07700 900781" }));
    expect(post.status).toBe(201);
    expect(post.headers["access-control-allow-origin"]).toBe(
      "https://customer-site.example",
    );
  });

  // The limiter shares one IP bucket per process — keep this test last so
  // earlier assertions never trip it (10 requests / 10 minutes).
  it("rate limits repeated submissions with 429 RATE_LIMITED", async () => {
    let limited: request.Response | null = null;
    for (let attempt = 0; attempt < 12 && !limited; attempt += 1) {
      const res = await request(app)
        .post(`/api/v1/leads/public/${businessA}`)
        .send(enquiry({ phone: "07700 900790", message: `Hammer ${attempt}` }));
      if (res.status === 429) limited = res;
    }
    expect(limited).not.toBeNull();
    expect(limited?.body.error.code).toBe("RATE_LIMITED");
    // The standard draft headers tell clients when to retry.
    expect(limited?.headers["ratelimit-limit"]).toBeDefined();
  });
});
