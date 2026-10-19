import { Environment, Paddle } from "@paddle/paddle-node-sdk";
import { env } from "./env";

/**
 * Paddle environment resolution (IMPLEMENTATION_PLAN Phase H).
 *
 * Everything Paddle reads its environment from `PADDLE_ENV` — never a
 * default. If the key or secret for the active environment is missing we
 * throw, so a half-configured deploy fails loudly instead of quietly hitting
 * the wrong Paddle account (§31).
 */

export type PaddleEnvironment = "sandbox" | "live";

export function paddleEnvironment(): PaddleEnvironment {
  return env.PADDLE_ENV;
}

/** The SDK's environment enum for the configured environment. */
export function paddleSdkEnvironment(): Environment {
  return env.PADDLE_ENV === "live" ? Environment.production : Environment.sandbox;
}

/** Server-side API key for the active environment. */
export function paddleApiKey(): string {
  const key =
    env.PADDLE_ENV === "sandbox"
      ? env.PADDLE_SANDBOX_API_KEY
      : env.PADDLE_LIVE_API_KEY;

  if (!key) {
    throw new Error(
      `PADDLE_${env.PADDLE_ENV.toUpperCase()}_API_KEY is not set — refusing to call Paddle.`,
    );
  }
  return key;
}

/**
 * Webhook signing secret for the active environment. This is the
 * notification destination's secret, not the API key (§1 of the brief).
 */
export function paddleWebhookSecret(): string {
  const secret =
    env.PADDLE_ENV === "sandbox"
      ? env.PADDLE_WEBHOOK_SANDBOX_SECRET
      : env.PADDLE_WEBHOOK_LIVE_SECRET;

  if (!secret) {
    throw new Error(
      `PADDLE_WEBHOOK_${env.PADDLE_ENV.toUpperCase()}_SECRET is not set — refusing to verify webhooks.`,
    );
  }
  return secret;
}

/** Base URL for direct REST calls, if any are needed. */
export function paddleApiBaseUrl(): string {
  return env.PADDLE_ENV === "sandbox"
    ? "https://sandbox-api.paddle.com"
    : "https://api.paddle.com";
}

let cached: Paddle | null = null;

/** Shared Paddle client for the active environment. */
export function paddleClient(): Paddle {
  if (!cached) {
    cached = new Paddle(paddleApiKey(), { environment: paddleSdkEnvironment() });
  }
  return cached;
}
