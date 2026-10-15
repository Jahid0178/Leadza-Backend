import { logger } from "../../utils/logger";
import {
  AiProviderError,
  type AiChatMessage,
  type AiCompletion,
  type AiCompletionRequest,
  type AiProvider,
  type AiToolCall,
  type AiUsage,
} from "../provider";

/**
 * OpenAI-compatible chat provider (FEATURES §23, IMPLEMENTATION_PLAN step 20).
 *
 * Speaks the `/chat/completions` shape so it works with OpenAI and any
 * drop-in gateway (Azure, OpenRouter, a self-hosted OpenAI-compatible
 * server…) by changing `AI_BASE_URL`. It uses the platform `fetch` — no
 * vendor SDK — so the dependency surface stays at zero (agent.md §2).
 */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OpenAiCompatibleConfig {
  apiKey: string;
  /** Base URL without the trailing `/chat/completions`, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  model: string;
  maxOutputTokens: number;
  temperature: number;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Raw shape we read from the response (everything else is ignored). */
interface RawCompletion {
  model?: unknown;
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: Array<{
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
}

/** Tool-call arguments travel as a JSON string; keep strings as-is. */
function toArgumentsString(args: unknown): string {
  return typeof args === "string" ? args : JSON.stringify(args ?? {});
}

/** Map our chat turn onto OpenAI's message shape (incl. tool calling). */
function toOpenAiMessage(message: AiChatMessage): Record<string, unknown> {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      ...(message.toolCalls?.length
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: toArgumentsString(call.arguments) },
            })),
          }
        : {}),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId ?? "",
      content: message.content,
    };
  }
  return { role: message.role, content: message.content };
}

/** Read tool calls out of the response, dropping nameless entries. */
function parseToolCalls(raw: RawCompletion["choices"]): AiToolCall[] {
  const calls = raw?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls
    .map((call) => ({
      id: typeof call.id === "string" ? call.id : "",
      name: typeof call.function?.name === "string" ? call.function.name : "",
      arguments: call.function?.arguments,
    }))
    .filter((call) => call.name.length > 0);
}

/** Coerce a token count to a non-negative integer. */
function toTokenCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function parseUsage(raw: RawCompletion["usage"], fallbackText: string): AiUsage {
  const inputTokens = toTokenCount(raw?.prompt_tokens);
  const outputTokens = toTokenCount(raw?.completion_tokens);
  const totalTokens = toTokenCount(raw?.total_tokens) || inputTokens + outputTokens;
  // Some gateways omit usage entirely; approximate from characters so cost
  // tracking still has a number (~4 chars/token is the usual rule of thumb).
  if (totalTokens === 0) {
    const approxOutput = Math.ceil(fallbackText.length / 4);
    return { inputTokens: 0, outputTokens: approxOutput, totalTokens: approxOutput };
  }
  return { inputTokens, outputTokens, totalTokens };
}

export function createOpenAiCompatibleProvider(
  config: OpenAiCompatibleConfig,
): AiProvider {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl: FetchLike = config.fetchImpl ?? fetch;

  return {
    name: "openai-compatible",
    async complete(request: AiCompletionRequest): Promise<AiCompletion | null> {
      const maxOutputTokens = request.maxOutputTokens ?? config.maxOutputTokens;
      const temperature = request.temperature ?? config.temperature;

      const requestBody: Record<string, unknown> = {
        model: config.model,
        messages: [
          { role: "system", content: request.system },
          ...request.messages.map(toOpenAiMessage),
        ],
        max_tokens: maxOutputTokens,
        temperature,
      };
      if (request.tools && request.tools.length > 0) {
        requestBody.tools = request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));
        requestBody.tool_choice = request.toolChoice ?? "auto";
      }
      const body = JSON.stringify(requestBody);

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // Network/timeout — let the caller retry (agent.md §24 background job).
        throw new AiProviderError(
          `AI provider request failed: ${(err as Error).message}`,
          "openai-compatible",
        );
      }

      if (!response.ok) {
        // Never surface upstream bodies to users; log them for debugging.
        const detail = await response.text().catch(() => "");
        logger.warn(
          { status: response.status, detail: detail.slice(0, 500) },
          "AI provider returned an error status",
        );
        throw new AiProviderError(
          `AI provider responded with ${response.status}`,
          "openai-compatible",
          response.status,
        );
      }

      const payload = (await response.json().catch(() => null)) as RawCompletion | null;
      const rawContent = payload?.choices?.[0]?.message?.content;
      const text = typeof rawContent === "string" ? rawContent.trim() : "";
      const toolCalls = parseToolCalls(payload?.choices);
      // A turn is valid if it says something OR asks for tools.
      if (text.length === 0 && toolCalls.length === 0) {
        throw new AiProviderError(
          "AI provider returned no message content",
          "openai-compatible",
        );
      }

      return {
        text,
        model: typeof payload?.model === "string" ? payload.model : config.model,
        usage: parseUsage(payload?.usage, text),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    },
  };
}
