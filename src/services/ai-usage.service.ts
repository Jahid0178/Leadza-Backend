import type {
  AdminAiUsagePageDto,
  AdminBusinessAiUsageDto,
} from "../validation/admin.schemas";
import {
  groupAiUsageByModel,
  listAiUsageForAdmin,
  sumAiUsageForBusiness,
  sumAiUsageForPlatform,
  type AiUsageBusinessQuery,
  type AiUsagePeriod,
  type AiRunUsageEntry,
  createAiUsage,
} from "../repositories/ai-usage.repository";
import { currentUsagePeriod } from "./usage.service";
import { logger } from "../utils/logger";

/**
 * AI usage service (FEATURES §49, IMPLEMENTATION_PLAN step 32).
 *
 * `recordAiUsage` is the write path the agent pipeline calls; it must never
 * break a reply, so persistence errors are logged, not thrown. The read
 * functions serve the platform admin area — every window is the same UTC
 * calendar month the usage limits (step 31) use, so "what did this tenant
 * cost" and "what has it used up" always describe the same month.
 */

/**
 * Persist one agent run's usage. Errors here never break a reply: a failed
 * insert costs a log line, not a lost model response (agents call this after
 * the provider already answered).
 */
export async function recordAiUsage(entry: AiRunUsageEntry): Promise<void> {
  try {
    await createAiUsage(entry);
    logger.info(
      {
        aiUsage: {
          businessId: entry.businessId,
          conversationId: entry.conversationId,
          provider: entry.provider,
          model: entry.model,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          totalTokens: entry.totalTokens,
          estimatedCostUsd: entry.estimatedCostUsd,
        },
      },
      "ai usage recorded",
    );
  } catch (err) {
    logger.error(
      { err, businessId: entry.businessId, conversationId: entry.conversationId },
      "failed to persist AI usage",
    );
  }
}

/** GET /api/v1/admin/usage — per-business cost + volume for this month. */
export async function readAdminAiUsage(
  query: AiUsageBusinessQuery,
): Promise<AdminAiUsagePageDto> {
  const period: AiUsagePeriod = currentUsagePeriod();
  const [page, summary] = await Promise.all([
    listAiUsageForAdmin(query, period),
    sumAiUsageForPlatform(period),
  ]);

  return {
    usage: page.rows,
    summary,
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
    total: page.total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** The per-business panel on the admin business detail page (this month). */
export async function readBusinessAiUsage(
  businessId: string,
): Promise<AdminBusinessAiUsageDto> {
  const period: AiUsagePeriod = currentUsagePeriod();
  const [totals, byModel] = await Promise.all([
    sumAiUsageForBusiness(businessId, period),
    groupAiUsageByModel(businessId, period),
  ]);

  return {
    period: {
      start: period.start.toISOString(),
      end: period.end.toISOString(),
    },
    totals: {
      runs: totals.runs,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      totalTokens: totals.totalTokens,
      estimatedCost: totals.estimatedCost,
    },
    lastUsedAt: totals.lastUsedAt,
    byModel,
  };
}