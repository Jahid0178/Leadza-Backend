import type { ConversationChannel } from "../../generated/prisma/client";
import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";
import { loadAgentContext } from "./context";
import { enforceGuardrails, type GuardrailViolation } from "./guardrails";
import { buildSystemPrompt } from "./prompts/system-prompt";
import {
  createAiProviderFromEnv,
  type AiProvider,
  type AiUsage,
} from "./provider";
import { estimateCostUsd, logAiUsage } from "./usage";

/**
 * The lead agent run (FEATURES §23, §25, IMPLEMENTATION_PLAN step 20).
 *
 *   load context → gate on status → build prompt → model call
 *     → guardrails → re-check status → save → log usage
 *
 * It is deliberately NOT called from an HTTP request: the public lead form
 * fires a background job (see ../jobs/ai-reply-queue.ts) so a slow model never
 * blocks a customer's submission (agent.md §24, §59).
 *
 * Two safety properties live here rather than in the prompt:
 *   - the agent refuses to write unless the thread is AI_ACTIVE, so a human
 *     takeover always wins the race (§26);
 *   - the guardrails run on the model's output before it is persisted, so an
 *     invented price can never reach a customer (§25).
 */

export type AgentRunStatus = "replied" | "skipped" | "failed";

export interface AgentRunResult {
  status: AgentRunStatus;
  /** Machine-readable reason for a skip/failure (logs + tests). */
  reason?: string;
  messageId?: string;
  provider?: string;
  model?: string;
  usage?: AiUsage;
  guardrailViolations?: GuardrailViolation[];
}

export interface AgentRunOptions {
  /** Injected in tests; defaults to the env-configured provider. */
  provider?: AiProvider;
}

export async function runLeadAgent(
  conversationId: string,
  options: AgentRunOptions = {},
): Promise<AgentRunResult> {
  const provider = options.provider ?? createAiProviderFromEnv();

  const context = await loadAgentContext(conversationId);
  if (!context) {
    return { status: "skipped", reason: "not_found", provider: provider.name };
  }

  // 1. The AI only speaks while it owns the conversation (§25, §26).
  if (context.conversation.status !== "AI_ACTIVE") {
    return {
      status: "skipped",
      reason: `conversation_${context.conversation.status.toLowerCase()}`,
      provider: provider.name,
    };
  }

  // Nothing new from the customer → no unsolicited reply.
  if (!context.currentMessage) {
    return { status: "skipped", reason: "no_customer_message", provider: provider.name };
  }

  const system = buildSystemPrompt(context);
  const messages = [
    ...context.history,
    { role: "user" as const, content: context.currentMessage },
  ];

  let completion;
  try {
    completion = await provider.complete({ system, messages });
  } catch (err) {
    // The queue owns retries; here we just report a safe failure.
    logger.error(
      { err, conversationId, provider: provider.name },
      "AI provider call failed",
    );
    return { status: "failed", reason: "provider_error", provider: provider.name };
  }

  if (!completion) {
    // No model configured — stay silent rather than fabricate (agent.md §17).
    return { status: "skipped", reason: "provider_disabled", provider: provider.name };
  }

  // 2. Safety gate on the model's words before anything is stored (§25).
  const guarded = enforceGuardrails(completion.text, {
    allowedPrices: context.services
      .filter((service) => service.price !== null)
      .map((service) => ({ service: service.name, amount: service.price as number })),
    availabilityVerified: context.availability.verified,
  });

  if (!guarded.ok) {
    logger.warn(
      {
        conversationId,
        businessId: context.conversation.businessId,
        violations: guarded.violations,
        provider: provider.name,
        model: completion.model,
      },
      "AI reply blocked by guardrails — safe fallback sent",
    );
  }

  // 3. Re-check the status and write atomically: a staff member may have taken
  // the thread over while the model was thinking, and a human takeover must
  // always stop the AI (§26).
  const saved = await prisma.$transaction(async (tx) => {
    const fresh = await tx.conversation.findUnique({
      where: { id: conversationId },
      select: { status: true },
    });
    if (!fresh || fresh.status !== "AI_ACTIVE") return null;

    const message = await tx.message.create({
      data: {
        conversationId,
        sender: "AI",
        content: guarded.text,
        channel: context.conversation.channel as ConversationChannel,
        aiGenerated: true,
      },
    });

    // Keep the inbox ordering correct (it sorts on conversation.updatedAt).
    await tx.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    return message;
  });

  if (!saved) {
    return { status: "skipped", reason: "taken_over", provider: provider.name };
  }

  // 4. Per-call usage/cost log (§49 — persisted in step 32).
  const estimatedCostUsd = estimateCostUsd(completion.model, completion.usage);
  logAiUsage({
    businessId: context.conversation.businessId,
    conversationId,
    messageId: saved.id,
    provider: provider.name,
    model: completion.model,
    usage: completion.usage,
    estimatedCostUsd,
  });

  return {
    status: "replied",
    messageId: saved.id,
    provider: provider.name,
    model: completion.model,
    usage: completion.usage,
    guardrailViolations: guarded.violations,
  };
}
