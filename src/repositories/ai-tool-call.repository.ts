import type { AiToolCallStatus, Prisma } from "../../generated/prisma/client";
import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";

/**
 * AI tool-call ledger (IMPLEMENTATION_PLAN step 21).
 *
 * One row per tool the agent invokes, so a questionable reply can be traced to
 * the backend decision behind it: which tool, which lead/conversation, the
 * arguments, the safe result, and whether it was allowed. Writes are
 * best-effort — a ledger failure must never break a customer reply (same
 * contract as the usage log).
 */

export interface AiToolCallEntry {
  businessId: string;
  conversationId: string;
  leadId?: string | null;
  tool: string;
  status: AiToolCallStatus;
  /** Parsed arguments the model supplied, for debugging. */
  arguments?: unknown;
  /** Safe, model-facing result payload when status is OK. */
  result?: unknown;
  /** Safe error message when status is DENIED or ERROR. */
  error?: string | null;
}

/**
 * Round-trip through JSON so a Date or other non-plain value still stores.
 * Returns undefined for values that cannot be represented.
 */
function toJsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    const plain = JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
    return plain;
  } catch {
    return undefined;
  }
}

export async function recordAiToolCall(entry: AiToolCallEntry): Promise<void> {
  try {
    await prisma.aiToolCall.create({
      data: {
        businessId: entry.businessId,
        conversationId: entry.conversationId,
        leadId: entry.leadId ?? null,
        tool: entry.tool,
        status: entry.status,
        ...(toJsonValue(entry.arguments) !== undefined
          ? { arguments: toJsonValue(entry.arguments) }
          : {}),
        ...(toJsonValue(entry.result) !== undefined
          ? { result: toJsonValue(entry.result) }
          : {}),
        error: entry.error ?? null,
      },
    });
  } catch (err) {
    logger.warn({ err, tool: entry.tool }, "failed to record AI tool call");
  }
}
