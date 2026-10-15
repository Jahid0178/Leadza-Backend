import { OpenRouter } from "@openrouter/sdk";
import type { ChatMessages } from "@openrouter/sdk/models";
import { logger } from "../../utils/logger";
import {
  AiProviderError,
  type AiCompletion,
  type AiCompletionRequest,
  type AiProvider,
  type AiUsage,
} from "../provider";

/**
 * OpenRouter chat provider (FEATURES §23, IMPLEMENTATION_PLAN step 20).
 *
 * Uses the official `@openrouter/sdk` so the OpenRouter-specific request and
 * response shapes (camelCase usage, model routing) are handled by a supported
 * client rather than hand-rolled HTTP. The agent only ever sees an `AiProvider`,
 * so swapping the concrete provider (see ../provider.ts) changes nothing else.
 *
 * The SDK call is injectable via `send` so tests can pin the contract without a
 * network or an API key — the same trick the OpenAI-compatible provider uses
 * with `fetchImpl`.
 */

/** A chat turn in the OpenAI/OpenRouter shape the SDK expects. */
interface OpenRouterChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** The transport-facing part of a completion request. */
export interface OpenRouterChatRequest {
  model: string;
  messages: OpenRouterChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

/** Injected in tests; resolves to the raw chat-completion payload. */
export type OpenRouterChatSend = (request: OpenRouterChatRequest) => Promise<unknown>;

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  temperature: number;
  /** Injected in tests; defaults to the real SDK client. */
  send?: OpenRouterChatSend;
  timeoutMs?: number;
  /** Optional usage attribution shown in the OpenRouter dashboard. */
  appTitle?: string;
  httpReferer?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Put a role on a concrete SDK message variant so it satisfies the union. */
function toSdkMessage(message: OpenRouterChatMessage): ChatMessages {
  switch (message.role) {
    case "assistant":
      return { role: "assistant", content: message.content };
    case "user":
      return { role: "user", content: message.content };
    default:
      return { role: "system", content: message.content };
  }
}

/** Build the default transport backed by the official SDK client. */
function createSdkSend(config: OpenRouterConfig): OpenRouterChatSend {
  const client = new OpenRouter({
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(config.appTitle ? { appTitle: config.appTitle } : {}),
    ...(config.httpReferer ? { httpReferer: config.httpReferer } : {}),
  });

  return (request) =>
    client.chat.send({
      chatRequest: {
        model: request.model,
        messages: request.messages.map(toSdkMessage),
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      },
    });
}

/** Raw shape we read from the payload (everything else is ignored). */
interface RawCompletion {
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: {
    promptTokens?: unknown;
    completionTokens?: unknown;
    totalTokens?: unknown;
  };
}

/** Coerce a token count to a non-negative integer. */
function toTokenCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** Best-effort HTTP status from an SDK error, for logging only. */
function errorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const status = (err as { statusCode?: unknown; status?: unknown }).statusCode ??
    (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/** Map the SDK payload onto the agent's `AiCompletion`. */
function parseCompletion(raw: unknown, fallbackModel: string): AiCompletion {
  const payload = (raw ?? {}) as RawCompletion;
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new AiProviderError("OpenRouter returned no message content", "openrouter");
  }

  const text = content.trim();
  const inputTokens = toTokenCount(payload.usage?.promptTokens);
  const outputTokens = toTokenCount(payload.usage?.completionTokens);
  const totalTokens = toTokenCount(payload.usage?.totalTokens) || inputTokens + outputTokens;
  // Some models omit usage; approximate from characters so cost tracking still
  // has a number (~4 chars/token is the usual rule of thumb).
  const usage: AiUsage =
    totalTokens === 0
      ? { inputTokens: 0, outputTokens: Math.ceil(text.length / 4), totalTokens: Math.ceil(text.length / 4) }
      : { inputTokens, outputTokens, totalTokens };

  return {
    text,
    model: typeof payload.model === "string" ? payload.model : fallbackModel,
    usage,
  };
}

export function createOpenRouterProvider(config: OpenRouterConfig): AiProvider {
  const send = config.send ?? createSdkSend(config);

  return {
    name: "openrouter",
    async complete(request: AiCompletionRequest): Promise<AiCompletion | null> {
      const messages: OpenRouterChatMessage[] = [
        { role: "system", content: request.system },
        ...request.messages,
      ];

      let raw: unknown;
      try {
        raw = await send({
          model: config.model,
          messages,
          maxTokens: request.maxOutputTokens ?? config.maxOutputTokens,
          temperature: request.temperature ?? config.temperature,
        });
      } catch (err) {
        // Network/timeout/HTTP — let the caller's queue retry (agent.md §24).
        if (err instanceof AiProviderError) throw err;
        const status = errorStatus(err);
        logger.warn(
          { err, status, provider: "openrouter" },
          "OpenRouter request failed",
        );
        throw new AiProviderError(
          `OpenRouter request failed: ${(err as Error).message}`,
          "openrouter",
          status,
        );
      }

      return parseCompletion(raw, config.model);
    },
  };
}
