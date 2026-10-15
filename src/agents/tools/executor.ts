import { recordAiToolCall } from "../../repositories/ai-tool-call.repository";
import { logger } from "../../utils/logger";
import type { AiToolCall } from "../provider";
import { findAgentTool } from "./registry";
import type { ToolContext, ToolOutcome } from "./types";

/**
 * Tool-call execution (FEATURES §24, agent.md §16, IMPLEMENTATION_PLAN step 21).
 *
 * The single chokepoint between the model and the application: it resolves the
 * tool by name from the registry, parses the model's arguments, and runs the
 * tool — which validates them and enforces ownership. Everything it does is
 * written to the ledger. A failing tool never throws: the model receives a safe
 * error and can recover, and a crash can never reach the customer.
 */

export interface ToolExecution {
  call: AiToolCall;
  outcome: ToolOutcome;
}

/** Tool arguments arrive as a JSON string (OpenAI shape); tolerate objects. */
function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    // Let the tool's schema reject the malformed value.
    return raw;
  }
}

export async function executeToolCall(
  ctx: ToolContext,
  call: AiToolCall,
): Promise<ToolExecution> {
  const tool = findAgentTool(call.name);

  if (!tool) {
    const error = `Unknown tool "${call.name}".`;
    await recordAiToolCall({
      businessId: ctx.businessId,
      conversationId: ctx.conversationId,
      leadId: ctx.leadId,
      tool: call.name,
      status: "DENIED",
      error,
    });
    logger.warn({ tool: call.name, conversationId: ctx.conversationId }, "AI requested an unknown tool");
    return { call, outcome: { ok: false, denied: true, error } };
  }

  const args = parseArguments(call.arguments);

  let outcome: ToolOutcome;
  try {
    outcome = await tool.execute(ctx, args);
  } catch (err) {
    logger.error({ err, tool: tool.name, conversationId: ctx.conversationId }, "AI tool threw");
    outcome = { ok: false, error: "The tool failed unexpectedly." };
  }

  await recordAiToolCall({
    businessId: ctx.businessId,
    conversationId: ctx.conversationId,
    leadId: ctx.leadId,
    tool: tool.name,
    status: outcome.ok ? "OK" : outcome.denied ? "DENIED" : "ERROR",
    arguments: args,
    result: outcome.ok ? outcome.data : undefined,
    error: outcome.ok ? null : (outcome.error ?? "Tool failed."),
  });

  return { call, outcome };
}
