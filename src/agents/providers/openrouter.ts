import { OpenRouter } from "@openrouter/sdk";
import type {
  ChatFunctionTool,
  ChatMessages,
  ChatToolCall,
} from "@openrouter/sdk/models";
import { logger } from "../../utils/logger";
import {
  AiProviderError,
  type AiChatMessage,
  type AiCompletion,
  type AiCompletionRequest,
  type AiProvider,
  type AiToolCall,
  type AiToolDefinition,
  type AiUsage,
} from "../provider";

/**
 * OpenRouter chat provider (FEATURES §23, IMPLEMENTATION_PLAN step 20).
 *
 * Uses the official `@openrouter/sdk` so the OpenRouter-specific request and
 * response shapes (camelCase usage, model routing, function calling) are
 * handled by a supported client rather than hand-rolled HTTP. The agent only
 * ever sees an `AiProvider`, so swapping the concrete provider (see
 * ../provider.ts) changes nothing else.
 *
 * The SDK call is injectable via `send` so tests can pin the contract without a
 * network or an API key — the same trick the OpenAI-compatible provider uses
 * with `fetchImpl`.
 */

/** The transport-facing part of a completion request. */
export interface OpenRouterChatRequest {
  model: string;
  messages: AiChatMessage[];
  maxTokens?: number;
  temperature?: number;
  tools?: AiToolDefinition[];
  toolChoice?: "auto" | "none" | "required";
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

/** Tool-call arguments travel as a JSON string; keep strings as-is. */
function toArgumentsString(args: unknown): string {
  return typeof args === "string" ? args : JSON.stringify(args ?? {});
}

/** Map our tool call onto the SDK's function-call shape. */
function toSdkToolCall(call: AiToolCall): ChatToolCall {
  return {
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: toArgumentsString(call.arguments) },
  };
}

/** Map our tool definition onto the SDK's function tool shape. */
function toSdkTool(tool: AiToolDefinition): ChatFunctionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/** Put a role on a concrete SDK message variant so it satisfies the union. */
function toSdkMessage(message: AiChatMessage): ChatMessages {
  switch (message.role) {
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls?.length
          ? { toolCalls: message.toolCalls.map(toSdkToolCall) }
          : {}),
      };
    case "tool":
      return {
        role: "tool",
        toolCallId: message.toolCallId ?? "",
        content: message.content,
      };
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
        ...(request.tools && request.tools.length > 0
          ? {
              tools: request.tools.map(toSdkTool),
              toolChoice: request.toolChoice ?? "auto",
            }
          : {}),
      },
    });
}

/** Raw shape we read from the payload (everything else is ignored). */
interface RawCompletion {
  model?: unknown;
  choices?: Array<{
    message?: {
      content?: unknown;
      // The SDK returns camelCase; accept snake_case defensively.
      toolCalls?: unknown;
      tool_calls?: unknown;
    };
  }>;
  usage?: {
    promptTokens?: unknown;
    completionTokens?: unknown;
    totalTokens?: unknown;
    /** OpenRouter reports the request's own cost in USD when usage is returned. */
    cost?: unknown;
  };
}

/** Coerce a token count to a non-negative integer. */
function toTokenCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * Coerce OpenRouter's `usage.cost` to a non-negative USD number. Missing,
 * malformed or negative values mean "not reported" (undefined), so the cost
 * falls back to the estimate in ../usage.ts rather than storing a guess.
 */
function toReportedCostUsd(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 1_000_000) / 1_000_000;
}

/** Best-effort HTTP status from an SDK error, for logging only. */
function errorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const status = (err as { statusCode?: unknown; status?: unknown }).statusCode ??
    (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/** Read tool calls out of the first choice, dropping nameless entries. */
function parseToolCalls(payload: RawCompletion): AiToolCall[] {
  const message = payload.choices?.[0]?.message;
  const raw = message?.toolCalls ?? message?.tool_calls;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const call = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      return {
        id: typeof call.id === "string" ? call.id : "",
        name: typeof call.function?.name === "string" ? call.function.name : "",
        arguments: call.function?.arguments,
      };
    })
    .filter((call) => call.name.length > 0);
}

/** Map the SDK payload onto the agent's `AiCompletion`. */
function parseCompletion(raw: unknown, fallbackModel: string): AiCompletion {
  const payload = (raw ?? {}) as RawCompletion;
  const content = payload.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content.trim() : "";
  const toolCalls = parseToolCalls(payload);

  // A turn is valid if it says something OR asks for tools.
  if (text.length === 0 && toolCalls.length === 0) {
    throw new AiProviderError("OpenRouter returned no message content", "openrouter");
  }

  const inputTokens = toTokenCount(payload.usage?.promptTokens);
  const outputTokens = toTokenCount(payload.usage?.completionTokens);
  const totalTokens = toTokenCount(payload.usage?.totalTokens) || inputTokens + outputTokens;
  const reportedCostUsd = toReportedCostUsd(payload.usage?.cost);
  // Some models omit usage; approximate from characters so cost tracking still
  // has a number (~4 chars/token is the usual rule of thumb).
  const usage: AiUsage =
    totalTokens === 0
      ? {
          inputTokens: 0,
          outputTokens: Math.ceil(text.length / 4),
          totalTokens: Math.ceil(text.length / 4),
          ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
        }
      : {
          inputTokens,
          outputTokens,
          totalTokens,
          ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
        };

  return {
    text,
    model: typeof payload.model === "string" ? payload.model : fallbackModel,
    usage,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

export function createOpenRouterProvider(config: OpenRouterConfig): AiProvider {
  const send = config.send ?? createSdkSend(config);

  return {
    name: "openrouter",
    async complete(request: AiCompletionRequest): Promise<AiCompletion | null> {
      const messages: AiChatMessage[] = [
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
          tools: request.tools,
          // Default to letting the model decide when tools are on offer.
          toolChoice:
            request.tools && request.tools.length > 0
              ? (request.toolChoice ?? "auto")
              : request.toolChoice,
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
