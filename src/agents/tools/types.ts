import type { z, ZodType } from "zod";

/**
 * AI tool layer (FEATURES §24, agent.md §15–16, IMPLEMENTATION_PLAN step 21).
 *
 * The agent never runs application code the model wrote. It may only invoke
 * one of these registered tools, and the backend — not the model — decides
 * whether the call is allowed and what it may touch:
 *
 *   model → validated tool call → zod args → ownership check → service/repository
 *
 * `ctx` is built from the conversation the agent is already authorised for, so
 * a model-supplied `businessId`/`leadId` can never widen the blast radius
 * (agent.md §16: never trust an LLM-generated businessId).
 */

/** Server-resolved facts a tool may act on — never taken from model output. */
export interface ToolContext {
  /** Verified business id of the conversation. */
  businessId: string;
  conversationId: string;
  customerId: string;
  /** The conversation's linked lead, when it has one. */
  leadId: string | null;
}

/** What a tool returns to the model (and the ledger records). */
export interface ToolOutcome {
  ok: boolean;
  /** Model-facing payload; JSON-serialisable. */
  data?: unknown;
  /** Safe, model-facing error when `ok` is false. */
  error?: string;
  /**
   * True when the backend *refused* the call (unknown/bad args, or a resource
   * owned by another tenant) rather than the handler failing. Drives the
   * ledger's DENIED vs ERROR status.
   */
  denied?: boolean;
}

/** A tool exposed to the agent. `execute` validates args before handling. */
export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema advertised to the model. */
  parameters: Record<string, unknown>;
  /** Validate the model's raw arguments and run the handler. */
  execute: (ctx: ToolContext, args: unknown) => Promise<ToolOutcome>;
}

/** Config for `defineTool` — ties a zod schema to its handler typed by it. */
export interface ToolDefinitionConfig<S extends ZodType> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  schema: S;
  handle: (ctx: ToolContext, input: z.infer<S>) => Promise<ToolOutcome>;
}

/**
 * Build an `AgentTool` from a zod-validated handler. Arguments from the model
 * are parsed by the schema; anything malformed is refused before the handler
 * runs (agent.md §14: never trust runtime input).
 */
export function defineTool<S extends ZodType>(
  config: ToolDefinitionConfig<S>,
): AgentTool {
  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    async execute(ctx, args) {
      const parsed = config.schema.safeParse(args ?? {});
      if (!parsed.success) {
        return { ok: false, denied: true, error: "Invalid arguments for this tool." };
      }
      return config.handle(ctx, parsed.data);
    },
  };
}
