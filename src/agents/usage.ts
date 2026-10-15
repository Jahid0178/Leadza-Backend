import { logger } from "../utils/logger";
import type { AiUsage } from "./provider";

/**
 * AI usage tracking (FEATURES §49, IMPLEMENTATION_PLAN step 20 → 32).
 *
 * Step 20 logs one structured line per agent run: provider, model, token
 * counts and an estimated cost, keyed by business. Step 32 turns this into a
 * persisted `AiUsage` table plus the /admin/usage views and billing limits;
 * keeping the shape identical here means that migration is additive.
 *
 * The price table below is PLACEHOLDER data — it exists so cost is visible in
 * logs today, and must be replaced with sourced, current rates in step 32
 * (working agreement #5: placeholder data stays visibly marked).
 */

/** USD per 1,000,000 tokens, by model. Placeholder — verify in step 32. */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2, output: 8 },
};

/** Look up a model's price, tolerating date/version suffixes (…-2024-07-18). */
function priceFor(model: string): { input: number; output: number } | null {
  const exact = MODEL_PRICING[model];
  if (exact) return exact;
  const prefix = Object.keys(MODEL_PRICING).find((key) => model.startsWith(key));
  return prefix ? (MODEL_PRICING[prefix] ?? null) : null;
}

/** Estimated cost in USD; 0 for an unpriced model rather than a guess. */
export function estimateCostUsd(model: string, usage: AiUsage): number {
  const price = priceFor(model);
  if (!price) return 0;
  const cost =
    (usage.inputTokens / 1_000_000) * price.input +
    (usage.outputTokens / 1_000_000) * price.output;
  // Round to 6dp so logs stay readable.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export interface AiUsageLogEntry {
  businessId: string;
  conversationId: string;
  messageId?: string;
  provider: string;
  model: string;
  usage: AiUsage;
  estimatedCostUsd: number;
}

/** Emit one usage record. Errors here must never break a reply. */
export function logAiUsage(entry: AiUsageLogEntry): void {
  logger.info(
    {
      aiUsage: {
        businessId: entry.businessId,
        conversationId: entry.conversationId,
        messageId: entry.messageId ?? null,
        provider: entry.provider,
        model: entry.model,
        inputTokens: entry.usage.inputTokens,
        outputTokens: entry.usage.outputTokens,
        totalTokens: entry.usage.totalTokens,
        estimatedCostUsd: entry.estimatedCostUsd,
      },
    },
    "ai usage",
  );
}
