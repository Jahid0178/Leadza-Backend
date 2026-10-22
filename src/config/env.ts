import "dotenv/config";
import { z } from "zod";

/**
 * Environment is validated at startup (agent.md §31).
 * Never expose server-only secrets to the frontend.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  /** Auth.js secret — minimum 32 random characters (agent.md §31, §32). */
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),

  /** Frontend origin allowed to send credentialed requests. */
  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  /**
   * AI agent (IMPLEMENTATION_PLAN step 20). "auto" prefers OpenRouter when
   * OPENROUTER_API_KEY is set, then the generic OpenAI-compatible provider
   * when AI_API_KEY is set, and stays disabled otherwise — so the platform
   * runs (silently) before a model is wired up.
   */
  AI_PROVIDER: z
    .enum(["auto", "disabled", "openai-compatible", "openrouter"])
    .default("auto"),
  AI_API_KEY: z.string().min(1).optional(),
  /** OpenRouter key (https://openrouter.ai/settings/keys). */
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  /** OpenRouter model id — the `:free` suffix selects a free model. */
  OPENROUTER_MODEL: z.string().min(1).default("nvidia/nemotron-3.5-super-vl:free"),
  /** Base URL of any OpenAI-compatible /chat/completions endpoint. */
  AI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  AI_MODEL: z.string().min(1).default("gpt-4o-mini"),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(8000).default(600),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),
  /** How many prior messages the agent replays as chat history. */
  AI_HISTORY_LIMIT: z.coerce.number().int().positive().max(100).default(20),

  /**
   * Lead scoring rules (FEATURES §18, IMPLEMENTATION_PLAN step 23).
   * Deterministic point weights — the backend always computes the score from
   * these rules, never the model. Defaults sum to LEAD_SCORE_MAX.
   */
  LEAD_SCORE_SERVICE: z.coerce.number().int().min(0).max(100).default(20),
  /** Points for a location the business's own service areas cover (§18). */
  LEAD_SCORE_AREA: z.coerce.number().int().min(0).max(100).default(15),
  LEAD_SCORE_URGENCY_HIGH: z.coerce.number().int().min(0).max(100).default(15),
  LEAD_SCORE_URGENCY_MEDIUM: z.coerce.number().int().min(0).max(100).default(8),
  LEAD_SCORE_URGENCY_LOW: z.coerce.number().int().min(0).max(100).default(4),
  /** Appointment intent — a preferred date and/or time was given (§18). */
  LEAD_SCORE_APPOINTMENT: z.coerce.number().int().min(0).max(100).default(15),
  /** Required information — a substantive customer message (≥ 20 chars). */
  LEAD_SCORE_INFORMATION: z.coerce.number().int().min(0).max(100).default(5),
  LEAD_SCORE_BUDGET: z.coerce.number().int().min(0).max(100).default(15),
  /** Contact completeness — reachable by phone and/or email (§18). */
  LEAD_SCORE_PHONE: z.coerce.number().int().min(0).max(100).default(10),
  LEAD_SCORE_EMAIL: z.coerce.number().int().min(0).max(100).default(5),
  /** Score ceiling: the stored score is always 0..LEAD_SCORE_MAX. */
  LEAD_SCORE_MAX: z.coerce.number().int().min(1).max(100).default(100),

  /**
   * Booking / availability (FEATURES §35, IMPLEMENTATION_PLAN step 27).
   * Slots are generated from the business's own opening hours; a booking
   * defaults to this duration when its service names none.
   */
  BOOKING_DEFAULT_DURATION: z.coerce.number().int().positive().max(1440).default(60),
  /** Shortest slot the calendar will generate (minutes). */
  BOOKING_MIN_DURATION: z.coerce.number().int().positive().max(1440).default(15),
  /** Upper bound on how many days of availability are computed in one call. */
  BOOKING_MAX_RANGE_DAYS: z.coerce.number().int().positive().max(366).default(62),

  /**
   * Paddle billing (IMPLEMENTATION_PLAN Phase H, agent.md §12).
   *
   * `PADDLE_ENV` is required and has **no default**: the process must never
   * silently fall back to the wrong Paddle account. Keys and webhook secrets
   * for the inactive environment stay optional, so a sandbox process only
   * needs the sandbox values and vice versa.
   */
  PADDLE_ENV: z.enum(["sandbox", "live"]),
  PADDLE_SANDBOX_API_KEY: z.string().min(1).optional(),
  PADDLE_LIVE_API_KEY: z.string().min(1).optional(),
  PADDLE_WEBHOOK_SANDBOX_SECRET: z.string().min(1).optional(),
  PADDLE_WEBHOOK_LIVE_SECRET: z.string().min(1).optional(),

  /**
   * Shared rate-limit store (IMPLEMENTATION_PLAN step 36). With both Upstash
   * values, express-rate-limit counters live in Upstash Redis (REST API) and
   * survive restarts / are shared across instances; missing values keep the
   * built-in per-process store so dev and the test suite stay hermetic.
   */
  UPSTASH_REDIS_REST_URL: blankToOptional(z.string().url()),
  UPSTASH_REDIS_REST_TOKEN: blankToOptional(z.string().min(1)),

  /**
   * How many reverse-proxy hops sit in front of this process and terminate
   * the client's connection (step 36). Trusting the whole chain (`true`) would
   * let a client spoof `X-Forwarded-For` and defeat per-IP limiters; a hop
   * count trusts only that many. Defaults: 1 behind a production proxy,
   * 0 (direct) otherwise. Override explicitly per deployment topology.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).optional(),

  /**
   * Auth route budgets (step 52, step 36): the anonymous /auth POST endpoints
   * are the credential-stuffing door, so they are rate limited. Defaults are
   * generous for humans and tight enough to blunt spraying.
   */
  AUTH_RATE_WINDOW_MINUTES: z.coerce.number().int().positive().max(1440).default(15),
  AUTH_LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(20),
  AUTH_REGISTER_RATE_LIMIT: z.coerce.number().int().positive().default(10),
});

/** Empty-string env values mean "unset" (dotenv keeps placeholders blank). */
function blankToOptional<TSchema extends z.ZodType>(schema: TSchema) {
  return z.preprocess((value) => {
    if (typeof value === "string" && value.trim().length === 0) return undefined;
    return value;
  }, schema.optional());
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const parsedEnv = parsed.data;

/** Resolved proxy trust: explicit hops, else one behind a production proxy. */
export const TRUST_PROXY_HOPS =
  parsedEnv.TRUST_PROXY_HOPS ?? (parsedEnv.NODE_ENV === "production" ? 1 : 0);

/**
 * Secrets audit (§52, step 36): refuse obviously placeholder secrets in
 * production. A dev default that reaches a live deployment is a breach-in-
 * waiting, and the JWT secret signs every session, so it is checked here —
 * length was already validated by the schema.
 */
const PLACEHOLDER_SECRET = /(?:changeme|change-me|placeholder|example|dev-?secret|super-?secret|please-change|fixme)/i;

function isWeakSecret(value: string): boolean {
  if (PLACEHOLDER_SECRET.test(value)) return true;
  // All one repeated character — not entropy, just padding.
  return new Set(value.split("")).size === 1;
}

if (parsedEnv.NODE_ENV === "production" && isWeakSecret(parsedEnv.AUTH_SECRET)) {
  console.error(
    "FATAL: AUTH_SECRET looks like a placeholder value. Generate a real secret " +
      "(https://generate-secret.vercel.app/32) and set AUTH_SECRET before serving production traffic.",
  );
  process.exit(1);
}

export const env = parsedEnv;
