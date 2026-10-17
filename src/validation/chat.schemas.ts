import { z } from "zod";

/**
 * Public website chat (FEATURES §22, IMPLEMENTATION_PLAN step 19).
 *
 * The same anonymous embed as the lead form, but conversational: a visitor
 * sends a message, the backend stores it, the AI replies in the background,
 * and the widget polls for the reply. No authentication — the caller is an
 * anonymous visitor, so the payload carries only what the visitor typed. The
 * business comes from the URL and the thread is proven by its access token,
 * never by a client-supplied id (agent.md §7, §13).
 *
 * Identity is required to START a thread: the widget asks for a name and one
 * way to reply before the first message, so a chat always leaves behind a lead
 * the business can actually follow up (§21 parity with the enquiry form). When
 * a thread already exists (`conversationId` + token) the fields are optional —
 * the visitor is simply continuing the conversation. `website` is the same
 * hidden honeypot the lead form uses.
 */
export const publicChatMessageSchema = z
  .object({
    message: z
      .string()
      .trim()
      .min(1, "Type a message.")
      .max(4000, "Message must be 4000 characters or fewer."),
    /** Set once the widget has a thread; absent on the very first message. */
    conversationId: z.string().trim().min(1).max(64).optional(),
    name: z
      .string()
      .trim()
      .max(120, "Name must be 120 characters or fewer.")
      .nullable()
      .optional(),
    phone: z
      .string()
      .trim()
      .min(5, "Phone number must be at least 5 characters.")
      .max(30, "Phone number must be 30 characters or fewer.")
      .nullable()
      .optional(),
    email: z
      .email("Enter a valid email address.")
      .max(254, "Email must be 254 characters or fewer.")
      .nullable()
      .optional(),
    /** Honeypot — see the doc comment above. */
    website: z.string().max(500).optional(),
  })
  .superRefine((values, ctx) => {
    // Continuing an existing thread needs no identity — only a new one does.
    if (values.conversationId) return;

    if (!values.name) {
      ctx.addIssue({
        code: "custom",
        path: ["name"],
        message: "Tell us your name so we know who we are talking to.",
      });
    }
    if (!values.phone && !values.email) {
      ctx.addIssue({
        code: "custom",
        path: ["phone"],
        message: "Add a phone number or email so we can reply.",
      });
    }
  });

export type PublicChatMessageInput = z.infer<typeof publicChatMessageSchema>;

/**
 * POST /api/v1/chat/public/:businessRef/typing — the visitor is typing in an
 * existing thread. No content, just the pointer to the thread; the access
 * token still gates it. Ephemeral: nothing is stored (§22).
 */
export const publicChatTypingSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(64),
    typing: z.boolean().optional(),
  })
  .strict();

export type PublicChatTypingInput = z.infer<typeof publicChatTypingSchema>;
