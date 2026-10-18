import { randomBytes } from "node:crypto";
import { prisma } from "../lib/prisma";
import {
  publishConversationCreated,
  publishMessageCreated,
} from "../realtime/hub";
import { clearTyping, setTyping, typingState } from "../realtime/typing";
import { findCustomerByIdentity } from "./customer.repository";
import { findPublicActiveService } from "./service.repository";
import type { PublicChatMessageInput } from "../validation/chat.schemas";

/**
 * Public website chat pipeline (FEATURES §22, IMPLEMENTATION_PLAN step 19):
 * validate business → resolve the thread → store the visitor's message →
 * (controller) trigger the AI → the widget polls for the reply.
 *
 * Thread ownership is proven with an opaque `publicToken` minted per thread,
 * never by the conversation id alone, so one visitor can never read another's
 * conversation (§13). A message may start a new thread (create customer →
 * lead → conversation) or continue an existing one.
 */

/** Placeholder name until the visitor (or the AI) gives a real one (§22). */
const ANONYMOUS_NAME = "Website visitor";
/** Newest messages returned to the widget, oldest-first. */
const MESSAGE_HISTORY_LIMIT = 100;

export interface ChatThread {
  conversationId: string;
  token: string;
  status: string;
  /** True when this message opened a new thread. */
  created: boolean;
}

export type ChatStartOutcome =
  | { ok: true; result: ChatThread }
  | { ok: false; reason: "not_found" | "suspended" | "invalid_conversation" };

export interface ChatMessageView {
  id: string;
  sender: "CUSTOMER" | "AI" | "HUMAN";
  content: string;
  createdAt: Date;
}

export type ChatMessagesOutcome =
  | {
      ok: true;
      messages: ChatMessageView[];
      status: string;
      /** Who is replying right now — the widget shows a typing bubble (§22). */
      typing: { AI: boolean; HUMAN: boolean };
    }
  | { ok: false; reason: "not_found" | "invalid_conversation" };

export interface ChatBusiness {
  id: string;
  name: string;
}

export type ChatBusinessOutcome =
  | { ok: true; business: ChatBusiness }
  | { ok: false; reason: "not_found" | "suspended" };

/** The public shape of a service the widget may offer in its select menu. */
export interface ChatPublicService {
  id: string;
  name: string;
}

/**
 * The business's active services for the widget's select (§10, §17). Ids and
 * names only — prices stay behind the authenticated API and the AI's
 * guardrails (§25).
 */
export async function listPublicServices(
  businessId: string,
): Promise<ChatPublicService[]> {
  return prisma.service.findMany({
    where: { businessId, active: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

/** Resolve the public business ref against the database (§8 status rule). */
export async function resolveChatBusiness(
  businessRef: string,
): Promise<ChatBusinessOutcome> {
  const business = await prisma.business.findUnique({
    where: { id: businessRef },
    select: { id: true, name: true, status: true },
  });
  if (!business) return { ok: false, reason: "not_found" };
  if (business.status !== "ACTIVE") return { ok: false, reason: "suspended" };
  return { ok: true, business: { id: business.id, name: business.name } };
}

/** A fresh, unguessable per-thread access token. */
function mintToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Exact match for the thread token (a 192-bit random value). */
function tokenMatches(stored: string | null, provided: string | undefined): boolean {
  return Boolean(stored) && typeof provided === "string" && stored === provided;
}

/**
 * Store the visitor's message, creating the thread on the first message.
 * `token` is the thread access token sent by the widget (header); ignored
 * when starting a new thread.
 */
export async function startOrContinueChat(
  businessRef: string,
  input: PublicChatMessageInput,
  token: string | undefined,
): Promise<ChatStartOutcome> {
  const resolved = await resolveChatBusiness(businessRef);
  if (!resolved.ok) return resolved;
  const business = resolved.business;

  // Continue an existing thread — only with the matching token.
  if (input.conversationId) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: { id: true, businessId: true, status: true, publicToken: true },
    });
    if (
      !conversation ||
      conversation.businessId !== business.id ||
      !tokenMatches(conversation.publicToken, token)
    ) {
      return { ok: false, reason: "invalid_conversation" };
    }

    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender: "CUSTOMER",
        content: input.message,
        channel: "WEBSITE",
      },
    });
    // Keep the dashboard inbox ordering correct (sorts on updatedAt).
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    // Live for every open dashboard (§38).
    publishMessageCreated(business.id, message);

    return {
      ok: true,
      result: {
        conversationId: conversation.id,
        token: conversation.publicToken as string,
        status: conversation.status,
        created: false,
      },
    };
  }

  // First message: reuse an existing customer when contact details match,
  // otherwise open an anonymous one the AI can qualify (§14, §22).
  let customer = await findCustomerByIdentity(business.id, {
    phone: input.phone,
    email: input.email,
  });
  if (!customer) {
    customer = await prisma.customer.create({
      data: {
        businessId: business.id,
        name: input.name?.trim() || ANONYMOUS_NAME,
        email: input.email ?? null,
        phone: input.phone ?? null,
      },
    });
  }

  // Qualification the visitor supplied up front (§15, §17). The service must
  // belong to THIS business and still be active — a foreign or archived id
  // is ignored, never linked (§13).
  const serviceId = input.serviceId
    ? (await findPublicActiveService(business.id, input.serviceId))?.id ?? null
    : null;

  const tokenValue = mintToken();
  const { conversation, message } = await prisma.$transaction(async (tx) => {
    const lead = await tx.lead.create({
      data: {
        businessId: business.id,
        customerId: customer.id,
        serviceId,
        urgency: input.urgency ?? null,
        preferredDate: input.preferredDate ?? null,
        source: "WEBSITE",
        customerMessage: input.message,
      },
    });
    const conversation = await tx.conversation.create({
      data: {
        businessId: business.id,
        customerId: customer.id,
        leadId: lead.id,
        channel: "WEBSITE",
        publicToken: tokenValue,
      },
    });
    const message = await tx.message.create({
      data: {
        conversationId: conversation.id,
        sender: "CUSTOMER",
        content: input.message,
        channel: "WEBSITE",
      },
    });
    return { conversation, message };
  });

  // A brand-new thread plus its first message, live for the dashboard (§38).
  publishConversationCreated(business.id, conversation.id);
  publishMessageCreated(business.id, message);

  return {
    ok: true,
    result: {
      conversationId: conversation.id,
      token: tokenValue,
      status: conversation.status,
      created: true,
    },
  };
}

/**
 * Read a thread's messages, gated on the thread token. Returns CUSTOMER, AI
 * and HUMAN replies (a staff takeover must reach the visitor, §24); SYSTEM
 * notes stay internal.
 */
export async function listChatMessages(
  businessRef: string,
  conversationId: string,
  token: string | undefined,
): Promise<ChatMessagesOutcome> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, businessId: true, status: true, publicToken: true },
  });
  if (!conversation || conversation.businessId !== businessRef) {
    return { ok: false, reason: "not_found" };
  }
  if (!tokenMatches(conversation.publicToken, token)) {
    return { ok: false, reason: "invalid_conversation" };
  }

  const rows = await prisma.message.findMany({
    where: {
      conversationId: conversation.id,
      sender: { in: ["CUSTOMER", "AI", "HUMAN"] },
    },
    orderBy: { createdAt: "desc" },
    take: MESSAGE_HISTORY_LIMIT,
  });

  const messages = rows.reverse().map((message) => ({
    id: message.id,
    sender: message.sender as ChatMessageView["sender"],
    content: message.content,
    createdAt: message.createdAt,
  }));

  const roles = typingState(conversation.id);

  return { ok: true, messages, status: conversation.status, typing: { AI: roles.AI, HUMAN: roles.HUMAN } };
}

export type ChatTypingOutcome =
  | { ok: true }
  | { ok: false; reason: "not_found" | "invalid_conversation" };

/**
 * Flag the visitor as typing (or not) for a thread they own. Nothing is stored;
 * the dashboard's socket is told, and the flag expires on its own (§22).
 */
export async function markVisitorTyping(
  businessRef: string,
  conversationId: string,
  token: string | undefined,
  typing: boolean,
): Promise<ChatTypingOutcome> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, businessId: true, publicToken: true },
  });
  if (!conversation || conversation.businessId !== businessRef) {
    return { ok: false, reason: "not_found" };
  }
  if (!tokenMatches(conversation.publicToken, token)) {
    return { ok: false, reason: "invalid_conversation" };
  }

  if (typing) {
    setTyping(businessRef, conversation.id, "CUSTOMER");
  } else {
    clearTyping(businessRef, conversation.id, "CUSTOMER");
  }

  return { ok: true };
}
