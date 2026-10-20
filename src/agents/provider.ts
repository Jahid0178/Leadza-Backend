import { env } from "../config/env";
import { logger } from "../utils/logger";
import { createOpenAiCompatibleProvider } from "./providers/openai-compatible";
import { createOpenRouterProvider } from "./providers/openrouter";

/**
 * LLM provider abstraction (FEATURES §23, agent.md §15, IMPLEMENTATION_PLAN
 * step 20).
 *
 * The agent never talks to a vendor SDK directly — it calls an `AiProvider`.
 * That keeps the model vendor swappable and lets every test run against a
 * deterministic fake instead of a live model. The concrete providers live in
 * ./providers.
 */

/**
 * One chat turn handed to the model.
 *
 * The `tool` role carries a tool result back to the model, and an `assistant`
 * turn may request tools via `toolCalls` — the two extra shapes function
 * calling needs (IMPLEMENTATION_PLAN step 21).
 */
export interface AiChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Set on an assistant turn that asked for tool calls. */
  toolCalls?: AiToolCall[];
  /** Set on a `tool` turn: the call it answers. */
  toolCallId?: string;
}

/**
 * A tool the model may call (name + JSON Schema). The agent translates these
 * into whichever shape the provider needs; the model never sees implementation
 * details, only the advertised contract (agent.md §15–16, step 21).
 */
export interface AiToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

/** A tool call requested by the model. `arguments` is raw JSON (parsed or string). */
export interface AiToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/** Everything a provider needs for one completion. */
export interface AiCompletionRequest {
  /** System prompt — the hard rules + business context (see prompts/). */
  system: string;
  /** Conversation turns, oldest first. */
  messages: AiChatMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  /** Tools the model may call. Omit for a plain reply. */
  tools?: AiToolDefinition[];
  /** How the model may use tools. Defaults to the provider's own default. */
  toolChoice?: "auto" | "none" | "required";
}

/** Token accounting returned by the provider (FEATURES §49, step 32). */
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /**
   * The provider's own reported cost in USD, when its response carries one
   * (OpenRouter does). Preferred over a price-table estimate wherever present.
   */
  reportedCostUsd?: number;
}

/** A completed model turn. */
export interface AiCompletion {
  /** The reply text — may be empty when the model only asked for tools. */
  text: string;
  model: string;
  usage: AiUsage;
  /** Tools the model asked to call; empty/undefined when it answered directly. */
  toolCalls?: AiToolCall[];
}

export interface AiProvider {
  /** Stable provider id recorded with every usage log (e.g. "disabled"). */
  readonly name: string;
  /**
   * Produce one reply. Returns `null` when the provider is not configured —
   * the agent then no-ops instead of failing, so the platform still works
   * before a model key exists (agent.md §17: never invent an answer).
   */
  complete(request: AiCompletionRequest): Promise<AiCompletion | null>;
}

/** Raised when a configured provider fails (network, HTTP, malformed body). */
export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

/**
 * The provider used when no model is configured. It answers `null`, so the
 * agent stays silent rather than fabricating a reply — the same behaviour as
 * before step 20, but now explicit and observable in the logs.
 */
export function createDisabledProvider(): AiProvider {
  return {
    name: "disabled",
    async complete() {
      return null;
    },
  };
}

/** The concrete provider a set of settings resolves to. */
export type AiProviderKind = "disabled" | "openai-compatible" | "openrouter";

export interface AiProviderSelection {
  provider: "auto" | "disabled" | "openai-compatible" | "openrouter";
  hasOpenRouterKey: boolean;
  hasGenericKey: boolean;
}

/**
 * Decide which provider to use (pure, so it is testable). `auto` prefers
 * OpenRouter — the default path for this project — then the generic
 * OpenAI-compatible HTTP provider, and stays disabled when no key exists so
 * the app runs silently instead of failing.
 */
export function resolveAiProviderKind(selection: AiProviderSelection): AiProviderKind {
  if (selection.provider === "disabled") return "disabled";
  if (selection.provider === "openrouter") {
    return selection.hasOpenRouterKey ? "openrouter" : "disabled";
  }
  if (selection.provider === "openai-compatible") {
    return selection.hasGenericKey ? "openai-compatible" : "disabled";
  }
  // auto
  if (selection.hasOpenRouterKey) return "openrouter";
  if (selection.hasGenericKey) return "openai-compatible";
  return "disabled";
}

/**
 * Whether any AI provider is configured. The website chat widget uses this to
 * decide between the conversational UI and the plain enquiry form, so a
 * business with no key set still gets a working form instead of a dead chat
 * (FEATURES §22 "optional conversational widget").
 */
export function isAiConfigured(): boolean {
  return (
    resolveAiProviderKind({
      provider: env.AI_PROVIDER,
      hasOpenRouterKey: Boolean(env.OPENROUTER_API_KEY),
      hasGenericKey: Boolean(env.AI_API_KEY),
    }) !== "disabled"
  );
}

/**
 * Resolve the provider from the environment (agent.md §31: never hardcode
 * secrets). `auto` prefers OpenRouter when its key is present, then the
 * OpenAI-compatible provider, and falls back to the disabled provider.
 */
export function createAiProviderFromEnv(): AiProvider {
  const kind = resolveAiProviderKind({
    provider: env.AI_PROVIDER,
    hasOpenRouterKey: Boolean(env.OPENROUTER_API_KEY),
    hasGenericKey: Boolean(env.AI_API_KEY),
  });

  if (kind === "openrouter") {
    return createOpenRouterProvider({
      apiKey: env.OPENROUTER_API_KEY ?? "",
      model: env.OPENROUTER_MODEL,
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
      temperature: env.AI_TEMPERATURE,
    });
  }

  if (kind === "openai-compatible") {
    return createOpenAiCompatibleProvider({
      apiKey: env.AI_API_KEY ?? "",
      baseUrl: env.AI_BASE_URL,
      model: env.AI_MODEL,
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
      temperature: env.AI_TEMPERATURE,
    });
  }

  logger.info(
    { provider: "disabled" },
    "AI provider disabled — set OPENROUTER_API_KEY (or AI_PROVIDER) to enable replies",
  );
  return createDisabledProvider();
}
