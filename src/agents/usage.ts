import type { AiUsage } from "./provider";

/**
 * AI cost estimation (FEATURES §49, IMPLEMENTATION_PLAN step 32).
 *
 * Cost for a run is, in order of preference:
 *   1. the provider's own reported cost (`usage.cost` — OpenRouter returns it),
 *   2. the price table below, for providers that report only tokens,
 *   3. zero — an unpriced model is never billed from a guess.
 *
 * The price table is the fallback for the generic OpenAI-compatible provider.
 * Rates below were checked against OpenAI's published per-1M-token prices
 * (verified 2026-10); refresh them when a model's price changes. OpenRouter
 * models resolve by their bare name, so a routed id like
 * `openai/gpt-4o-mini-2024-07-18` still matches.
 */

/** USD per 1,000,000 tokens, by model. */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4.1": { input: 2, output: 8 },
};

/** The comparable name for an id: vendor prefix and date/`free` suffixes off. */
function normalizedModel(model: string): string {
  const bare = model.split("/").pop() ?? model;
  return bare.split(":")[0] ?? bare;
}

/** Look up a model's price, tolerating version suffixes (…-2024-07-18). */
function priceFor(model: string): { input: number; output: number } | null {
  const key = normalizedModel(model);
  if (MODEL_PRICING[key]) return MODEL_PRICING[key];
  const bare = normalizedModel(model.replace(/-\d{4}-\d{2}-\d{2}$/, ""));
  if (MODEL_PRICING[bare]) return MODEL_PRICING[bare];
  const prefix = Object.keys(MODEL_PRICING).find((known) => bare.startsWith(known));
  return prefix ? (MODEL_PRICING[prefix] ?? null) : null;
}

/** Round to 6dp — the same precision the `ai_usage.estimatedCost` column keeps. */
export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Estimated cost in USD for one completion. A provider-reported cost wins;
 * otherwise the price table; 0 for an unpriced model rather than a guess.
 */
export function estimateCostUsd(model: string, usage: AiUsage): number {
  if (typeof usage.reportedCostUsd === "number") return roundUsd(usage.reportedCostUsd);
  const price = priceFor(model);
  if (!price) return 0;
  const cost =
    (usage.inputTokens / 1_000_000) * price.input +
    (usage.outputTokens / 1_000_000) * price.output;
  return roundUsd(cost);
}

/** Add one completion's accounting onto a run total (step 32). */
export function addUsageTotals(total: AiUsage, add: AiUsage): AiUsage {
  return {
    inputTokens: total.inputTokens + add.inputTokens,
    outputTokens: total.outputTokens + add.outputTokens,
    // Trust each turn's total (it may include reasoning tokens we never see
    // separately); fall back to the sum of the parts when it is absent.
    totalTokens: total.totalTokens + (add.totalTokens || add.inputTokens + add.outputTokens),
  };
}