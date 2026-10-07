import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

const app = createApp();

const stamp = Date.now();
const password = "s3cure-pass-1";
const rawEmail = `Mixed.Case-${stamp}@Example.com`;
const email = rawEmail.toLowerCase();

/** Extract the Auth.js session cookie from a response. */
function sessionCookieFrom(res: request.Response): string {
  const header = res.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  const session = cookies.find((cookie) => cookie.startsWith("authjs.session-token="));
  if (!session) throw new Error("expected an authjs.session-token cookie");
  return session.split(";")[0] ?? "";
}

describe("health", () => {
  it("reports ok with the database reachable", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("ok");
    expect(res.body.data.database).toBe("up");
  });
});

describe("response format", () => {
  it("returns the standard error envelope for unknown routes", async () => {
    const res = await request(app).get("/api/v1/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(typeof res.body.error.message).toBe("string");
  });
});

describe("auth", () => {
  it("validates input before touching the database (§14)", async () => {
    const res = await request(app).post("/api/v1/auth/register").send({
      name: "J",
      email: "not-an-email",
      password: "123",
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("registers a user, normalizes the email, and signs them in", async () => {
    const res = await request(app).post("/api/v1/auth/register").send({
      name: "Vitest User",
      email: rawEmail,
      password,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe(email); // lowercased
    expect(res.body.data.user.platformRole).toBe("USER");
    // Never leak sensitive fields (§26)
    expect(res.body.data.user).not.toHaveProperty("passwordHash");
    expect(JSON.stringify(res.body)).not.toContain(password);
    expect(sessionCookieFrom(res)).toContain("authjs.session-token=");
  });

  it("rejects duplicate registration with 409 (§25 safe errors)", async () => {
    const res = await request(app).post("/api/v1/auth/register").send({
      name: "Vitest User",
      email,
      password,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("rejects a wrong password with 401", async () => {
    const res = await request(app).post("/api/v1/auth/login").send({
      email,
      password: "definitely-wrong-999",
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("responds identically for unknown emails (no user enumeration)", async () => {
    const unknown = await request(app).post("/api/v1/auth/login").send({
      email: `nobody-${stamp}@example.com`,
      password,
    });
    const wrongPassword = await request(app).post("/api/v1/auth/login").send({
      email,
      password: "definitely-wrong-999",
    });
    expect(unknown.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(unknown.body.error.message).toBe(wrongPassword.body.error.message);
  });

  it("logs in with valid credentials and issues a session cookie", async () => {
    const res = await request(app).post("/api/v1/auth/login").send({ email, password });
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(email);
    expect(sessionCookieFrom(res)).toContain("authjs.session-token=");
  });

  it("returns the session user for a valid cookie", async () => {
    const login = await request(app).post("/api/v1/auth/login").send({ email, password });
    const cookie = sessionCookieFrom(login);

    const res = await request(app).get("/api/v1/auth/session").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(email);
  });

  it("returns a null session when anonymous", async () => {
    const res = await request(app).get("/api/v1/auth/session");
    expect(res.status).toBe(200);
    expect(res.body.data.user).toBeNull();
  });

  it("rejects protected routes without a session (§5)", async () => {
    const res = await request(app).get("/api/v1/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("serves the authenticated user on the protected route", async () => {
    const login = await request(app).post("/api/v1/auth/login").send({ email, password });
    const cookie = sessionCookieFrom(login);

    const res = await request(app).get("/api/v1/auth/me").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(email);
    expect(res.body.data.user.platformRole).toBe("USER");
  });

  it("clears the session cookie on logout", async () => {
    const login = await request(app).post("/api/v1/auth/login").send({ email, password });
    const cookie = sessionCookieFrom(login);

    const res = await request(app).post("/api/v1/auth/logout").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);

    const header = res.headers["set-cookie"];
    const cookies = Array.isArray(header) ? header : header ? [header] : [];
    const cleared = cookies.find((c) => c.startsWith("authjs.session-token="));
    expect(cleared).toBeDefined();
    expect(cleared).toContain("Expires=Thu, 01 Jan 1970");
  });
});
