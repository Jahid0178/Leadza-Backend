import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { errorHandler } from "../src/middleware/error";

/**
 * Security hardening tests (FEATURES §52, IMPLEMENTATION_PLAN step 36):
 * auth route rate limits answering the API envelope, security headers,
 * a sanitized 500, the production session-cookie flags, the route-method
 * contract behind the CSRF review, and the shared rate-limit store choice.
 */

// Must run before ../src/app is imported — the limiter budgets are read from
// env at module scope. Tight budgets make the exhaustion tests quick and do
// not depend on defaults.
vi.hoisted(() => {
  type Key = "AUTH_LOGIN_RATE_LIMIT" | "AUTH_REGISTER_RATE_LIMIT" | "AUTH_RATE_WINDOW_MINUTES";
  const keys: Key[] = ["AUTH_LOGIN_RATE_LIMIT", "AUTH_REGISTER_RATE_LIMIT", "AUTH_RATE_WINDOW_MINUTES"];
  const backup: Record<string, string | undefined> = {};
  for (const key of keys) {
    backup[key] = process.env[key];
    delete process.env[key];
  }
  (globalThis as { __securityTestEnv?: Record<string, string | undefined> }).__securityTestEnv = {
    ...backup,
  };
  process.env.AUTH_LOGIN_RATE_LIMIT = "2";
  process.env.AUTH_REGISTER_RATE_LIMIT = "3";
  process.env.AUTH_RATE_WINDOW_MINUTES = "15";
});

const app = createApp();

const stamp = Date.now();
const password = "s3cure-pass-1";

afterAll(() => {
  // process.env outlives this file inside the test worker — put back whatever
  // was there so later files see their own configuration.
  const backup =
    (globalThis as { __securityTestEnv?: Record<string, string | undefined> }).__securityTestEnv ?? {};
  for (const [key, value] of Object.entries(backup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("security headers (§52, helmet)", () => {
  it("sends nosniff, frame protection, a referrer policy and HSTS on the API", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["referrer-policy"]).toBeTruthy();
    expect(res.headers["strict-transport-security"]).toBeTruthy();
  });

  it("does not advertise the server framework", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("lets /widget.js be embedded cross-site (CORP override)", async () => {
    // helmet's same-origin default would block a cross-site classic <script>
    // — CORP applies to no-cors fetches — and the widget must embed anywhere.
    const res = await request(app).get("/widget.js");
    expect(res.status).toBe(200);
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });
});

describe("api error sanitization (§58, agent.md §25)", () => {
  it("a raw internal error never reaches the client as a stack or message", () => {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const res = { headersSent: false, status, json } as unknown as import("express").Response;
    const leak = new Error("connect failed: postgresql://dbuser:hunter2@db.internal/leadza");

    errorHandler(leak, {} as import("express").Request, res, {} as import("express").NextFunction);

    expect(status).toHaveBeenCalledWith(500);
    const call = json.mock.calls[0] as unknown as unknown[];
    const body = call[0] as { success: boolean; error: { code: string; message: string } };
    const serialized = JSON.stringify(body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    // Neither the stack, the message, nor a credential fragment may appear.
    expect(serialized).not.toContain("postgresql");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("connect failed");
  });

  it("refuses to double-render when headers are already sent", () => {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const res = { headersSent: true, status, json } as unknown as import("express").Response;

    expect(() =>
      errorHandler(new Error("late failure"), {} as import("express").Request, res, {} as import("express").NextFunction),
    ).not.toThrow();
    expect(status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
});

describe("csrf review contract (step 36)", () => {
  type Probe = { method: string };

  /** Walk an Express 5 router stack and collect every registered method. The
   * 5.x layer no longer exposes a mount-path string, so the method contract is
   * asserted on methods and probed behaviorally below. */
  function collectMethods(stack: unknown[], methods: Set<string>): void {
    for (const raw of stack) {
      const layer = raw as {
        route?: { methods?: Record<string, unknown> };
        name?: string;
        handle?: { stack?: unknown[] };
      };
      if (layer.route?.methods) {
        for (const method of Object.keys(layer.route.methods)) methods.add(method);
      } else if (layer.name === "router" && Array.isArray(layer.handle?.stack)) {
        collectMethods(layer.handle!.stack!, methods);
      }
    }
    return;
  }

  const router = (app as unknown as { router?: { stack: unknown[] }; _router?: { stack: unknown[] } })
    .router ?? (app as unknown as { _router?: { stack: unknown[] } })._router;
  const methods = new Set<string>();
  if (router) collectMethods(router.stack, methods);

  it("registers only read-safe or explicitly-mutating http methods", () => {
    expect(methods.size).toBeGreaterThan(2);
    const allowed = new Set(["get", "head", "options", "post", "patch", "delete"]);
    const unexpected = [...methods].filter((method) => !allowed.has(method));
    // e.g. a PUT or a GET-mutation sneaking in would trip this.
    expect(unexpected).toEqual([]);
  });

  it("the anonymous auth endpoints have no GET handler", async () => {
    // A GET login/register/logout is a state mutation through the weakest
    // method (query credentials, prefetchers, <img> tricks) — the review's
    // premise is that they cannot exist, so assert the 404 envelope.
    for (const endpoint of ["register", "login", "logout"]) {
      const res = await request(app).get(`/api/v1/auth/${endpoint}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    }
  });

  it("gated mutations answer 401 to anonymous GET (never data)", async () => {
    // The paddle portal and the realtime token mint are POST mutations behind
    // a router-wide requireAuth; an anonymous GET must meet the auth wall,
    // never the handler.
    for (const path of ["/api/v1/paddle/portal", "/api/v1/paddle/reconcile", "/api/v1/realtime/token"]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHENTICATED");
    }
  });
});

describe("shared rate-limit store selection (step 36)", () => {
  it("falls back to memory when no Upstash credentials are configured", async () => {
    // The suite blanks the Upstash pair (vitest.config.ts) on purpose; this
    // file shares its module registry with the app above, so the factory has
    // already resolved.
    const { rateLimitStorage } = await import("../src/middleware/rate-limit");
    expect(rateLimitStorage()).not.toBe("upstash");
  });

  it("builds the shared Upstash store when credentials are present", async () => {
    const backupUrl = process.env.UPSTASH_REDIS_REST_URL;
    const backupToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    vi.resetModules();
    try {
      process.env.UPSTASH_REDIS_REST_URL = "https://security-test.upstash.io";
      process.env.UPSTASH_REDIS_REST_TOKEN = "security-test-token";
      const { rateLimitStorage } = await import("../src/middleware/rate-limit");
      // Only constructs the store — no request is sent here.
      expect(rateLimitStorage()).toBe("upstash");
    } finally {
      if (backupUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = backupUrl;
      if (backupToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = backupToken;
      vi.resetModules();
    }
  });
});

describe("rate limiting on the anonymous auth routes (§52, step 36)", () => {
  /**
   * Budgets pinned above: login 2, register 3 per window for this app
   * instance. supertest arrives from one IP, so each limiter's bucket is
   * shared across this file — the exhaustions deliberately run last and each
   * surface is counted exactly to its budget.
   */

  it("registers one fixture user inside the budget", async () => {
    const res = await request(app).post("/api/v1/auth/register").send({
      name: "Rate Fixture",
      email: `rate-fixture-${stamp}@example.com`,
      password,
    });
    expect(res.status).toBe(201);
  });

  it("uses the register budget, then answers the envelope with 429", async () => {
    const second = await request(app).post("/api/v1/auth/register").send({
      name: "Rate Second",
      email: `rate-second-${stamp}@example.com`,
      password,
    });
    expect([201, 409]).toContain(second.status); // budget slot, possibly a duplicate fixture

    const third = await request(app).post("/api/v1/auth/register").send({
      name: "Rate Third",
      email: `rate-third-${stamp}@example.com`,
      password,
    });
    expect([201, 409]).toContain(third.status); // last budget slot

    const over = await request(app).post("/api/v1/auth/register").send({
      name: "Rate Over",
      email: `rate-over-${stamp}@example.com`,
      password,
    });
    expect(over.status).toBe(429);
    expect(over.body.success).toBe(false);
    expect(over.body.error.code).toBe("RATE_LIMITED");
    expect(typeof over.body.error.message).toBe("string");
    // Standard rate-limit headers are present (§37 observability).
    expect(over.headers["ratelimit-limit"]).toBe("3");
    expect(over.headers["ratelimit-remaining"]).toBe("0");
  });

  it("blunts a password-spray run on login with 429 after the budget", async () => {
    const first = await request(app).post("/api/v1/auth/login").send({
      email: `rate-fixture-${stamp}@example.com`,
      password: "wrong-password-1",
    });
    expect(first.status).toBe(401);
    expect(first.headers["ratelimit-remaining"]).toBe("1");

    const second = await request(app).post("/api/v1/auth/login").send({
      email: `rate-fixture-${stamp}@example.com`,
      password: "wrong-password-2",
    });
    expect(second.status).toBe(401);

    const third = await request(app).post("/api/v1/auth/login").send({
      email: `rate-fixture-${stamp}@example.com`,
      password: "wrong-password-3",
    });
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe("RATE_LIMITED");
    // The 429 must never reveal whether the account exists (§25).
    expect(JSON.stringify(third.body)).not.toContain("rate-fixture");
  });
});

describe("session cookie flags in production mode (§52)", () => {
  it("sends a __Secure- prefixed HttpOnly SameSite=Lax Secure cookie", async () => {
    vi.resetModules();
    const backup = {
      nodeEnv: process.env.NODE_ENV,
      authSecret: process.env.AUTH_SECRET,
    };
    process.env.NODE_ENV = "production";
    // A strong secret: the production secrets audit (env.ts) refuses placeholders.
    process.env.AUTH_SECRET =
      "production-security-test-secret-0123456789abcdefghij0123456789abcdef";
    try {
      const { createApp: createProductionApp } = await import("../src/app");
      const productionApp = createProductionApp();

      const res = await request(productionApp).post("/api/v1/auth/register").send({
        name: "Prod Cookie",
        email: `prod-cookie-${stamp}@example.com`,
        password,
      });
      expect(res.status).toBe(201);

      const header = res.headers["set-cookie"] as unknown as string[];
      const cookies = Array.isArray(header) ? header : header ? [header] : [];
      const session = cookies.find((cookie) => cookie.startsWith("__Secure-authjs.session-token="));
      expect(session).toBeDefined();
      expect(session).toContain("HttpOnly");
      expect(session).toContain("SameSite=Lax");
      expect(session).toContain("Secure");
      expect(session).not.toContain("Domain=");
    } finally {
      process.env.NODE_ENV = backup.nodeEnv;
      if (backup.authSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = backup.authSecret;
      vi.resetModules();
    }
  });
});