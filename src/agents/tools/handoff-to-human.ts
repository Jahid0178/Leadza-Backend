import { z } from "zod";
import { prisma } from "../../lib/prisma";
import {
  canTransitionConversation,
  type ConversationStatus,
} from "../../services/conversation-status";
import { defineTool } from "./types";

/**
 * handoffToHuman() — stop the AI and ask a person to take over (FEATURES §24,
 * agent.md §18, §26).
 *
 * Moves the conversation to HUMAN_REQUESTED through the backend-owned
 * transition table. Once requested, the agent's own status gate refuses to
 * store a reply, so the AI stops talking (step 24 adds the notification).
 */
export const handoffToHumanTool = defineTool({
  name: "handoffToHuman",
  description:
    "Request that a member of the team take over this conversation. Use it when " +
    "the customer asks for a person, or when the enquiry is outside what you can " +
    "handle. After calling it, the AI stops replying.",
  parameters: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Short reason for the handover." },
    },
    additionalProperties: false,
  },
  schema: z
    .object({ reason: z.string().trim().max(300).optional() })
    .strict(),
  async handle(ctx) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: ctx.conversationId },
      select: { id: true, businessId: true, status: true },
    });
    if (!conversation || conversation.businessId !== ctx.businessId) {
      return { ok: false, error: "Conversation not found." };
    }

    // Idempotent: a thread already waiting on (or in the hands of) a human is
    // exactly the requested state.
    if (conversation.status === "HUMAN_REQUESTED" || conversation.status === "HUMAN_ACTIVE") {
      return { ok: true, data: { status: conversation.status, alreadyRequested: true } };
    }

    if (
      !canTransitionConversation(
        conversation.status as ConversationStatus,
        "HUMAN_REQUESTED",
      )
    ) {
      return { ok: false, error: "A human cannot be requested for this conversation." };
    }

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { status: "HUMAN_REQUESTED" },
    });

    return { ok: true, data: { status: "HUMAN_REQUESTED" } };
  },
});
