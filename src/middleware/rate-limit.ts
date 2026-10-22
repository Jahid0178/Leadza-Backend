import { rateLimit, type Options, type RateLimitRequestHandler, type Store } from "express-rate-limit";
import { RedisStore, type SendCommandFn } from "rate-limit-redis";
import { env } from "../config/env";
import { apiError } from "../utils/api-response";
import { logger } from "../utils/logger";

/**
 * The shared rate-limit factory for the anonymous surfaces (FEATURES §52,
 * IMPLEMENTATION_PLAN step 36).
 *
 * Every limiter this module builds answers with the API's own error envelope
 * (`{ success: false, error: { code: "RATE_LIMITED" } }`, agent.md §26) and
 * sends the standard `RateLimit-*` response headers, so the widget and the
 * Next.js proxy can surface a truthful "slow down" state.
 *
 * Counters live in Upstash Redis when `UPSTASH_REDIS_REST_URL` +
 * `UPSTASH_REDIS_REST_TOKEN` are configured: they then survive restarts and
 * are shared across server instances. Without both values the library's
 * per-process store is used (dev, tests). The choice is made once, on first
 * use, and logged exactly once.
 */

export type RateLimitStorage = "upstash" | "memory";

let storage: RateLimitStorage;
let sendCommand: SendCommandFn | undefined;

/**
 * Which store the limiters currently use — observability and test hooks.
 * Resolved lazily on first limiter creation, logged exactly once.
 */
export function rateLimitStorage(): RateLimitStorage {
  if (storage) return storage;

  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = env;
  if (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) {
    storage = "upstash";
    sendCommand = upstashSendCommand(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN);
    logger.info("rate-limit store: Upstash Redis (shared)");
  } else if (UPSTASH_REDIS_REST_URL || UPSTASH_REDIS_REST_TOKEN) {
    storage = "memory";
    // One value without the other is almost certainly a deployment mistake —
    // surface it loudly instead of silently counting in-process.
    logger.warn(
      "rate-limit store: only one of UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN is set — using memory. Configure both for the shared store.",
    );
  } else {
    storage = "memory";
    logger.info("rate-limit store: memory (set UPSTASH_REDIS_REST_URL/TOKEN for the shared store)");
  }

  return storage;
}

/**
 * Upstash's REST wire protocol: POST a JSON-encoded command array, read back
 * `{ result }` (or `{ error }`). The @upstash/redis SDK has no raw
 * `sendCommand` — the exact shim rate-limit-redis expects is this handful of
 * lines, so we skip the indirection and speak REST directly. Fail-closed: a
 * store error surfaces (the limiter forwards it to the error middleware)
 * rather than silently disabling brute-force protection; Upstash is managed
 * and highly available, so the trade-off favors protection.
 */
function upstashSendCommand(url: string, token: string): SendCommandFn {
  return async (...args: string[]) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
      body: JSON.stringify(args),
      // A slow store must never hold a request host — fail this counter only.
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      throw new Error(`rate-limit store request failed (${response.status})`);
    }

    const payload = (await response.json().catch(() => null)) as
      | { result?: boolean | number | string | boolean[] | number[] | string[]; error?: string }
      | null;

    if (!payload || payload.error !== undefined) {
      throw new Error(payload?.error ?? "rate-limit store sent an unreadable reply");
    }

    return payload.result as boolean | number | string;
  };
}

/** Standard options every limiter here needs. */
type LimiterOptions = {
  name: string;
  windowMs: number;
  limit: number;
  /** Human copy for the 429 envelope; keep it specific to the surface. */
  message: string;
};

export function rateLimiter(options: LimiterOptions): RateLimitRequestHandler {
  if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
    throw new Error(`rate-limiter ${options.name}: windowMs must be positive`);
  }
  if (!Number.isFinite(options.limit) || options.limit <= 0) {
    throw new Error(`rate-limiter ${options.name}: limit must be positive`);
  }

  rateLimitStorage();

  // express-rate-limit forbids one store instance shared by several limiters
  // (ERR_ERL_STORE_REUSE) — each limiter gets its own RedisStore keyed by its
  // name, so counters can never collide across surfaces.
  const store: Store | undefined =
    sendCommand
      ? new RedisStore({ sendCommand, prefix: options.name })
      : undefined;

  const base: Partial<Options> = {
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    handler: (_req, res) => {
      res
        .status(429)
        .json(apiError("RATE_LIMITED", options.message));
    },
  };

  return rateLimit(base);
}

/** The auth routes' shared window (step 36; the budgets are their own knobs). */
export function authWindowMs(): number {
  return env.AUTH_RATE_WINDOW_MINUTES * 60 * 1000;
}