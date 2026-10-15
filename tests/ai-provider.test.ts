import { describe, expect, it } from "vitest";
import {
  AiProviderError,
  createDisabledProvider,
  resolveAiProviderKind,
} from "../src/agents/provider";
import { createOpenAiCompatibleProvider } from "../src/agents/providers/openai-compatible";
import { createOpenRouterProvider } from "../src/agents/providers/openrouter";

/**
 * Provider unit tests (IMPLEMENTATION_PLAN step 20).
 *
 * The provider is the one place the app talks to a model, so its contract is
 * pinned with an injected fetch — no network, no key.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const config = {
  apiKey: "test-key",
  baseUrl: "https://api.example.test/v1/",
  model: "gpt-4o-mini",
  maxOutputTokens: 600,
  temperature: 0.3,
};

const request = {
  system: "You are the assistant.",
  messages: [{ role: "user" as const, content: "Hello" }],
};

describe("createOpenAiCompatibleProvider", () => {
  it("posts to /chat/completions and parses text, model and usage", async () => {
    let calledUrl = "";
    let sentBody: unknown;
    const provider = createOpenAiCompatibleProvider({
      ...config,
      fetchImpl: async (url, init) => {
        calledUrl = url;
        sentBody = JSON.parse(String(init?.body));
        return jsonResponse({
          model: "gpt-4o-mini-2024-07-18",
          choices: [{ message: { content: "  Hi there.  " } }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        });
      },
    });

    const result = await provider.complete(request);

    // Trailing slash on the base URL must not double up.
    expect(calledUrl).toBe("https://api.example.test/v1/chat/completions");
    expect(result?.text).toBe("Hi there.");
    expect(result?.model).toBe("gpt-4o-mini-2024-07-18");
    expect(result?.usage).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });

    // The system prompt and turns are forwarded in OpenAI's shape.
    const body = sentBody as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages[0]).toEqual({ role: "system", content: "You are the assistant." });
    expect(body.messages[1]).toEqual({ role: "user", content: "Hello" });
  });

  it("approximates usage when a gateway omits it", async () => {
    const provider = createOpenAiCompatibleProvider({
      ...config,
      fetchImpl: async () =>
        jsonResponse({ choices: [{ message: { content: "12345678" } }] }),
    });

    const result = await provider.complete(request);
    expect(result?.usage.totalTokens).toBe(2); // 8 chars / 4
    expect(result?.usage.inputTokens).toBe(0);
  });

  it("throws AiProviderError on a non-ok status", async () => {
    const provider = createOpenAiCompatibleProvider({
      ...config,
      fetchImpl: async () => new Response("upstream boom", { status: 502 }),
    });

    await expect(provider.complete(request)).rejects.toBeInstanceOf(AiProviderError);
  });

  it("throws AiProviderError on a network failure", async () => {
    const provider = createOpenAiCompatibleProvider({
      ...config,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    await expect(provider.complete(request)).rejects.toBeInstanceOf(AiProviderError);
  });

  it("throws when the model returns no content", async () => {
    const provider = createOpenAiCompatibleProvider({
      ...config,
      fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "   " } }] }),
    });

    await expect(provider.complete(request)).rejects.toBeInstanceOf(AiProviderError);
  });
});

describe("createOpenRouterProvider", () => {
  const openRouterConfig = {
    apiKey: "sk-or-test",
    model: "nvidia/nemotron-3.5-super-vl:free",
    maxOutputTokens: 600,
    temperature: 0.3,
  };

  it("sends system + turns and parses text, model and usage (camelCase)", async () => {
    let sentModel = "";
    let sentMessages: unknown;
    let sentMaxTokens: unknown;
    const provider = createOpenRouterProvider({
      ...openRouterConfig,
      send: async (sent) => {
        sentModel = sent.model;
        sentMessages = sent.messages;
        sentMaxTokens = sent.maxTokens;
        return {
          model: "nvidia/nemotron-3.5-super-vl",
          choices: [{ message: { content: "  Hi there.  " } }],
          usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
        };
      },
    });

    const result = await provider.complete(request);

    expect(provider.name).toBe("openrouter");
    expect(sentModel).toBe("nvidia/nemotron-3.5-super-vl:free");
    expect(sentMaxTokens).toBe(600);
    expect(sentMessages).toEqual([
      { role: "system", content: "You are the assistant." },
      { role: "user", content: "Hello" },
    ]);
    expect(result?.text).toBe("Hi there.");
    expect(result?.model).toBe("nvidia/nemotron-3.5-super-vl");
    expect(result?.usage).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  });

  it("approximates usage when the response omits it", async () => {
    const provider = createOpenRouterProvider({
      ...openRouterConfig,
      send: async () => ({ choices: [{ message: { content: "12345678" } }] }),
    });

    const result = await provider.complete(request);
    expect(result?.usage.totalTokens).toBe(2); // 8 chars / 4
    expect(result?.usage.inputTokens).toBe(0);
  });

  it("throws AiProviderError when the model returns no content", async () => {
    const provider = createOpenRouterProvider({
      ...openRouterConfig,
      send: async () => ({ choices: [{ message: { content: "   " } }] }),
    });

    await expect(provider.complete(request)).rejects.toBeInstanceOf(AiProviderError);
  });

  it("wraps an SDK failure in AiProviderError, preserving the status", async () => {
    const provider = createOpenRouterProvider({
      ...openRouterConfig,
      send: async () => {
        throw Object.assign(new Error("rate limited"), { statusCode: 429 });
      },
    });

    await expect(provider.complete(request)).rejects.toMatchObject({
      name: "AiProviderError",
      provider: "openrouter",
      status: 429,
    });
  });
});

describe("resolveAiProviderKind", () => {
  const withKeys = (over: Partial<Parameters<typeof resolveAiProviderKind>[0]> = {}) => ({
    provider: "auto" as const,
    hasOpenRouterKey: false,
    hasGenericKey: false,
    ...over,
  });

  it("prefers OpenRouter under auto when its key is present", () => {
    expect(resolveAiProviderKind(withKeys({ hasOpenRouterKey: true, hasGenericKey: true }))).toBe(
      "openrouter",
    );
  });

  it("falls back to the OpenAI-compatible provider under auto", () => {
    expect(resolveAiProviderKind(withKeys({ hasGenericKey: true }))).toBe("openai-compatible");
  });

  it("stays disabled when no key exists", () => {
    expect(resolveAiProviderKind(withKeys())).toBe("disabled");
  });

  it("honours an explicit openrouter selection only with a key", () => {
    expect(resolveAiProviderKind(withKeys({ provider: "openrouter", hasOpenRouterKey: true }))).toBe(
      "openrouter",
    );
    expect(resolveAiProviderKind(withKeys({ provider: "openrouter" }))).toBe("disabled");
  });
});

describe("createDisabledProvider", () => {
  it("answers null so the agent stays silent instead of inventing", async () => {
    const provider = createDisabledProvider();
    expect(provider.name).toBe("disabled");
    await expect(provider.complete(request)).resolves.toBeNull();
  });
});
