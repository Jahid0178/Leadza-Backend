import type { AiToolDefinition } from "../provider";
import { calculateLeadScoreTool } from "./calculate-lead-score";
import { checkAvailabilityTool } from "./check-availability";
import { checkServiceAreaTool } from "./check-service-area";
import { createBookingTool } from "./create-booking";
import { getBusinessInfoTool } from "./get-business-info";
import { getServiceDetailsTool } from "./get-service-details";
import { handoffToHumanTool } from "./handoff-to-human";
import { updateLeadTool } from "./update-lead";
import type { AgentTool } from "./types";

/**
 * The tools the agent may call (FEATURES §24, IMPLEMENTATION_PLAN step 21).
 * This list is the whole surface area: if a name is not here, the executor
 * refuses it, so the model can never reach arbitrary code (agent.md §15).
 */
export const AGENT_TOOLS: readonly AgentTool[] = [
  getBusinessInfoTool,
  getServiceDetailsTool,
  checkServiceAreaTool,
  updateLeadTool,
  calculateLeadScoreTool,
  checkAvailabilityTool,
  createBookingTool,
  handoffToHumanTool,
];

const TOOLS_BY_NAME = new Map(AGENT_TOOLS.map((tool) => [tool.name, tool]));

/** Look up a tool by the name the model asked for; undefined = not allowed. */
export function findAgentTool(name: string): AgentTool | undefined {
  return TOOLS_BY_NAME.get(name);
}

/** The definitions advertised to the model for this run. */
export function agentToolDefinitions(): AiToolDefinition[] {
  return AGENT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}
