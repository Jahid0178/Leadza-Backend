import type { ConversationChannel } from "../../generated/prisma/client";
import type { UsageMetric } from "../config/plans";
import { prisma } from "../lib/prisma";
import { publishMessageCreated } from "../realtime/hub";
import { clearTyping, setTyping } from "../realtime/typing";
import { checkAiRun } from "../services/usage.service";
import { logger } from "../utils/logger";
import { loadAgentContext } from "./context";
import { enforceGuardrails, type GuardrailViolation } from "./guardrails";
import { buildSystemPrompt } from "./prompts/system-prompt";
import {
  createAiProviderFromEnv,
  type AiChatMessage,
  type AiCompletion,
  type AiProvider,
  type AiUsage,
} from "./provider";
import { estimateCostUsd, logAiUsage } from "./usage";
import { executeToolCall } from "./tools/executor";
import { agentToolDefinitions } from "./tools/registry";
import type { ToolContext } from "./tools/types";

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
  /** Set when a run was refused by the plan's usage allowance (step 31). */
  usageLimit?: { metric: UsageMetric; used: number; limit: number };
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

  // 2. Plan pre-flight (FEATURES §48, step 31): an active subscription and the
  // month's AI allowance are checked before any model call, so an exhausted
  // plan never costs a provider request. The customer's message is already
  // stored — staff can still answer it.
  const aiCheck = await checkAiRun(context.conversation.businessId, conversationId);
  if (!aiCheck.allowed) {
    return {
      status: "skipped",
      reason: aiCheck.reason,
      provider: provider.name,
      ...(aiCheck.reason === "limit_reached"
        ? {
            usageLimit: {
              metric: aiCheck.metric,
              used: aiCheck.used,
              limit: aiCheck.limit,
            },
          }
        : {}),
    };
  }

  const system = buildSystemPrompt(context);
  const tools = agentToolDefinitions();

  // Tools act on the conversation the agent is already authorised for — the
  // model never supplies these ids (agent.md §16).
  const toolContext: ToolContext = {
    businessId: context.conversation.businessId,
    conversationId,
    customerId: context.conversation.customerId,
    leadId: context.conversation.leadId,
  };

  const messages: AiChatMessage[] = [
    ...context.history,
    { role: "user", content: context.currentMessage },
  ];

  // The model may call tools, see the results, and answer — bounded so a loop
  // cannot run away. Tools are executed through the validated registry only.
  const MAX_TOOL_ROUNDS = 3;
  let completion: AiCompletion | null = null;
  let handoffRequested = false;
  /** Clock times a tool verified this run — the only times the AI may state. */
  const verifiedTimes = new Set<string>();

  // Show "AI is typing…" on the widget and dashboard while the model works.
  // Cleared in the `finally`, whatever this run does (§22).
  setTyping(context.conversation.businessId, conversationId, "AI");
  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      completion = await provider.complete({ system, messages, tools });
      if (!completion) break; // provider disabled — handled below

      const calls = completion.toolCalls ?? [];
      if (calls.length === 0) break; // the model answered directly

      messages.push({ role: "assistant", content: completion.text, toolCalls: calls });
      for (const call of calls) {
        const { outcome } = await executeToolCall(toolContext, call);
        if (call.name === "handoffToHuman" && outcome.ok) handoffRequested = true;
        // A tool that returned real slots/bookings tells the guardrail which
        // appointment times the model is allowed to mention (§25).
        if (outcome.ok && outcome.data && typeof outcome.data === "object") {
          const times = (outcome.data as { allowedTimes?: unknown }).allowedTimes;
          if (Array.isArray(times)) {
            for (const time of times) {
              if (typeof time === "string") verifiedTimes.add(time);
            }
          }
        }
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify(outcome),
        });
      }
      // A handover ends the turn: the AI must not keep talking (§26).
      if (handoffRequested) break;
    }
  } catch (err) {
    // The queue owns retries; here we just report a safe failure.
    logger.error(
      { err, conversationId, provider: provider.name },
      "AI provider call failed",
    );
    return { status: "failed", reason: "provider_error", provider: provider.name };
  } finally {
    clearTyping(context.conversation.businessId, conversationId, "AI");
  }

  if (!completion) {
    // No model configured — stay silent rather than fabricate (agent.md §17).
    return { status: "skipped", reason: "provider_disabled", provider: provider.name };
  }

  // The AI stopped because it asked for a person — do not add a reply on top.
  if (handoffRequested) {
    return {
      status: "skipped",
      reason: "handoff_requested",
      provider: provider.name,
      model: completion.model,
    };
  }

  // A model that only ever asked for tools produced nothing to send.
  if (completion.text.trim().length === 0) {
    return {
      status: "skipped",
      reason: "empty_reply",
      provider: provider.name,
      model: completion.model,
    };
  }

  // 3. Safety gate on the model's words before anything is stored (§25).
  const guarded = enforceGuardrails(completion.text, {
    allowedPrices: context.services
      .filter((service) => service.price !== null)
      .map((service) => ({ service: service.name, amount: service.price as number })),
    availabilityVerified: context.availability.verified,
    allowedTimes: [...verifiedTimes],
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

  // 4. Re-check the status and write atomically: a staff member may have taken
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

  // The reply is now stored — push it to any dashboard with this thread open
  // (the widget keeps polling, §38).
  publishMessageCreated(context.conversation.businessId, saved);

  // 5. Per-call usage/cost log (§49 — persisted in step 32).
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
