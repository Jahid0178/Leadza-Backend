import { z } from "zod";
import type { ConversationStatus } from "../services/conversation-status";

/** Conversation channels (FEATURES §19, §38). */
export const conversationChannelSchema = z.enum([
  "WEBSITE",
  "WHATSAPP",
  "EMAIL",
  "SMS",
  "FACEBOOK",
  "INSTAGRAM",
]);

/** All lifecycle statuses — validated transitions live in conversation-status.ts. */
export const conversationStatusSchema = z.enum([
  "AI_ACTIVE",
  "HUMAN_REQUESTED",
  "HUMAN_ACTIVE",
  "CLOSED",
]);

/** Who wrote a message (FEATURES §20). */
export const messageSenderSchema = z.enum(["CUSTOMER", "AI", "HUMAN", "SYSTEM"]);

export type ConversationChannel = z.infer<typeof conversationChannelSchema>;
export type MessageSender = z.infer<typeof messageSenderSchema>;
export type { ConversationStatus };

/** POST /api/v1/conversations — open a thread for an existing customer. */
export const createConversationSchema = z.object({
  businessId: z.string().trim().min(1, "Business is required."),
  customerId: z.string().trim().min(1, "Customer is required."),
  leadId: z.string().trim().min(1).nullable().optional(),
  channel: conversationChannelSchema.default("WEBSITE"),
});

export type CreateConversationInput = z.infer<typeof createConversationSchema>;

/** PATCH /api/v1/conversations/:id/status — body of the status endpoint. */
export const changeConversationStatusSchema = z
  .object({ status: conversationStatusSchema })
  .strict();

export type ChangeConversationStatusInput = z.infer<
  typeof changeConversationStatusSchema
>;

/**
 * POST /api/v1/conversations/:id/messages — a staff reply (§32). The sender is
 * always HUMAN on this route; the AI/system write path is internal (step 20).
 */
export const appendMessageSchema = z
  .object({
    content: z
      .string()
      .trim()
      .min(1, "Enter a message.")
      .max(4000, "Message must be 4000 characters or fewer."),
  })
  .strict();

export type AppendMessageInput = z.infer<typeof appendMessageSchema>;

/**
 * GET /api/v1/conversations — list query (§31: filter by AI/human status,
 * channel, assignee, plus search and pagination).
 */
export const listConversationsQuerySchema = z.object({
  businessId: z.string().trim().min(1).optional(),
  status: conversationStatusSchema.optional(),
  channel: conversationChannelSchema.optional(),
  assignedToId: z.string().trim().min(1).optional(),
  /** Scope to one customer or lead (lead detail links its conversations). */
  customerId: z.string().trim().min(1).optional(),
  leadId: z.string().trim().min(1).optional(),
  /** Free-text search over the customer's name/phone/email. */
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

/** Public message shape returned by the backend (agent.md §26). */
export interface MessageDto {
  id: string;
  conversationId: string;
  sender: MessageSender;
  content: string;
  channel: ConversationChannel;
  aiGenerated: boolean;
  externalMessageId: string | null;
  createdAt: Date;
}

/** Public conversation shape returned by the backend (agent.md §26). */
export interface ConversationDto {
  id: string;
  businessId: string;
  customerId: string;
  leadId: string | null;
  channel: ConversationChannel;
  status: ConversationStatus;
  assignedToId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
