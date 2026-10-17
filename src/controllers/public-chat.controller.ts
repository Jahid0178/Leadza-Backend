import type { Request, Response } from "express";
import { isAiConfigured } from "../agents/provider";
import { triggerAiReply } from "../services/ai-trigger";
import {
  listChatMessages,
  markVisitorTyping,
  resolveChatBusiness,
  startOrContinueChat,
} from "../repositories/public-chat.repository";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";
import {
  publicChatMessageSchema,
  publicChatTypingSchema,
} from "../validation/chat.schemas";

/**
 * Public website chat controller (FEATURES §22, IMPLEMENTATION_PLAN step 19).
 *
 * The conversational sibling of the public lead form: the visitor sends a
 * message, the backend stores it and enqueues the AI (never inside the request,
 * §59), and the widget polls for the reply. Thread reads are gated by the
 * per-thread token in the `x-chat-token` header — a header, not a query
 * parameter, so access tokens never land in request logs (§37).
 */

/** The thread token travels in this header. */
const TOKEN_HEADER = "x-chat-token";

function readToken(req: Request): string | undefined {
  const value = req.headers[TOKEN_HEADER];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * GET /api/v1/chat/public/:businessRef/status — is the AI on, and who is this?
 * The widget calls this first to choose the chat UI or fall back to the form.
 */
export async function getChatStatus(req: Request, res: Response) {
  const businessRef = req.params.businessRef;
  if (typeof businessRef !== "string" || businessRef.trim().length === 0) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  const resolved = await resolveChatBusiness(businessRef);
  if (!resolved.ok) {
    if (resolved.reason === "suspended") {
      throw ApiError.forbidden(
        "BUSINESS_SUSPENDED",
        "This business isn't accepting messages right now.",
      );
    }
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(
    apiSuccess({
      aiEnabled: isAiConfigured(),
      businessName: resolved.business.name,
    }),
  );
}

/**
 * POST /api/v1/chat/public/:businessRef — send a message.
 *
 * Order mirrors the lead form: honeypot → validation → database → enqueue the
 * AI. The AI runs in the background; the response only confirms the message
 * was accepted, so a slow model never holds the visitor's request open (§59).
 */
export async function postChatMessage(req: Request, res: Response) {
  const businessRef = req.params.businessRef;
  if (typeof businessRef !== "string" || businessRef.trim().length === 0) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  // Honeypot: invisible to visitors, tempting to bots. Answer plausibly but
  // store nothing (agent.md §25 spirit: never teach the attacker).
  const honeypot = (req.body as { website?: unknown } | null)?.website;
  if (typeof honeypot === "string" && honeypot.trim().length > 0) {
    res.status(201).json(apiSuccess({ accepted: true }));
    return;
  }

  const parsed = publicChatMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    throw ApiError.badRequest(
      "VALIDATION_ERROR",
      field ? `${field}: ${issue?.message}` : (issue?.message ?? "Invalid input."),
    );
  }

  const outcome = await startOrContinueChat(businessRef, parsed.data, readToken(req));
  if (!outcome.ok) {
    if (outcome.reason === "suspended") {
      throw ApiError.forbidden(
        "BUSINESS_SUSPENDED",
        "This business isn't accepting messages right now.",
      );
    }
    if (outcome.reason === "invalid_conversation") {
      throw ApiError.forbidden(
        "INVALID_CHAT_TOKEN",
        "This conversation can no longer be continued. Please start a new chat.",
      );
    }
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  // Hand the message to the AI in the background (§59). The widget polls for
  // the reply; a disabled provider leaves the message for a human instead.
  void triggerAiReply(outcome.result.conversationId);

  res.status(outcome.result.created ? 201 : 200).json(
    apiSuccess({
      conversationId: outcome.result.conversationId,
      token: outcome.result.token,
      status: outcome.result.status,
      aiEnabled: isAiConfigured(),
    }),
  );
}

/**
 * GET /api/v1/chat/public/:businessRef/:conversationId/messages — the thread.
 * The widget polls this and replaces its list, so an AI reply (or a staff
 * takeover, §24) appears without a socket. Gated by the thread token.
 */
export async function getChatMessages(req: Request, res: Response) {
  const { businessRef, conversationId } = req.params;
  if (
    typeof businessRef !== "string" ||
    typeof conversationId !== "string" ||
    businessRef.trim().length === 0 ||
    conversationId.trim().length === 0
  ) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  const outcome = await listChatMessages(businessRef, conversationId, readToken(req));
  if (!outcome.ok) {
    if (outcome.reason === "invalid_conversation") {
      throw ApiError.forbidden(
        "INVALID_CHAT_TOKEN",
        "This conversation can no longer be read. Please start a new chat.",
      );
    }
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(
    apiSuccess({
      messages: outcome.messages,
      status: outcome.status,
      typing: outcome.typing,
      aiEnabled: isAiConfigured(),
    }),
  );
}

/**
 * POST /api/v1/chat/public/:businessRef/typing — the visitor is typing.
 *
 * Nothing is stored and nothing is returned beyond 204: the dashboard learns
 * over its socket, and the flag expires by itself. Gated exactly like the
 * messages read (thread token), so one visitor can never signal another's
 * thread (§13).
 */
export async function postChatTyping(req: Request, res: Response) {
  const businessRef = req.params.businessRef;
  if (typeof businessRef !== "string" || businessRef.trim().length === 0) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  const parsed = publicChatTypingSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    throw ApiError.badRequest(
      "VALIDATION_ERROR",
      field ? `${field}: ${issue?.message}` : (issue?.message ?? "Invalid input."),
    );
  }

  const outcome = await markVisitorTyping(
    businessRef,
    parsed.data.conversationId,
    readToken(req),
    parsed.data.typing !== false,
  );
  if (!outcome.ok) {
    if (outcome.reason === "invalid_conversation") {
      throw ApiError.forbidden(
        "INVALID_CHAT_TOKEN",
        "This conversation can no longer be continued. Please start a new chat.",
      );
    }
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.status(204).end();
}
