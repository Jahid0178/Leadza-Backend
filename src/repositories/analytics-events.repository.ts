import type { AnalyticsEventType } from "../../generated/prisma/client";
import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";

/**
 * Analytics event ingestion (FEATURES §51, "Admin analytics" build).
 *
 * Append-only writes at the exact state-change sites of the flows that
 * produced them (§5 of the spec: "record structured events... use durable
 * database records"). Rows deliberately carry no relations — see the model
 * comment in schema.prisma.
 *
 * Ingestion is **best-effort and never fatal**: a failing analytics write
 * must not break lead intake, AI replies or bookings (§8), so every failure
 * is logged and swallowed. Idempotency comes from the flow itself, not from
 * here: each call site checks its own transition guards first, so a retried
 * flow re-reading its pre-condition is a no-op and never emits a second event
 * (the transition tables in src/services/*-status.ts).
 */

export interface AnalyticsEventInput {
  type: AnalyticsEventType;
  businessId: string;
  leadId?: string | null;
  conversationId?: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  /** "AI" when an agent tool drove the change, "STAFF" for human moves. */
  initiator?: string | null;
  /** Small non-sensitive context only (reason, provider) — never content. */
  metadata?: Record<string, string> | null;
}

/**
 * Record one analytics event. Never throws — resolution failures (the rare
 * prisma error) are logged with the existing logger and the caller's flow
 * continues untouched. Accepts a Prisma transaction client so an event is
 * written atomically with the state change wherever the caller is inside a
 * transaction.
 */
export async function recordAnalyticsEvent(
  input: AnalyticsEventInput,
  tx: Pick<typeof prisma, "analyticsEvent"> = prisma,
): Promise<void> {
  try {
    await tx.analyticsEvent.create({
      data: {
        type: input.type,
        businessId: input.businessId,
        leadId: input.leadId ?? null,
        conversationId: input.conversationId ?? null,
        fromStatus: input.fromStatus ?? null,
        toStatus: input.toStatus ?? null,
        initiator: input.initiator ?? null,
        metadata: input.metadata ?? undefined,
      },
    });
  } catch (error) {
    // Analytics must never become the reason a workflow fails (§8).
    logger.warn({ err: error, type: input.type }, "analytics event write failed");
  }
}