import { logger } from "../../utils/logger";
import {
  AiProviderError,
  type AiCompletion,
  type AiCompletionRequest,
  type AiProvider,
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
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
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

      const body = JSON.stringify({
        model: config.model,
        messages: [{ role: "system", content: request.system }, ...request.messages],
        max_tokens: maxOutputTokens,
        temperature,
      });

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
      const text = payload?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || text.trim().length === 0) {
        throw new AiProviderError(
          "AI provider returned no message content",
          "openai-compatible",
        );
      }

      const trimmed = text.trim();
      return {
        text: trimmed,
        model: typeof payload?.model === "string" ? payload.model : config.model,
        usage: parseUsage(payload?.usage, trimmed),
      };
    },
  };
}
