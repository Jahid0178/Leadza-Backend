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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
