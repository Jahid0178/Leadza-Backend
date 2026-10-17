import type { Request, Response } from "express";
import {
  appendMessageForUser,
  changeConversationStatusForUser,
  createConversationForUser,
  findConversationForUser,
  listConversationsForBusiness,
  listConversationsForUser,
} from "../repositories/conversation.repository";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";
import { clearTyping, setTyping } from "../realtime/typing";
import { parseAfterAuth, requireMembership } from "../utils/business-access";
import {
  appendMessageSchema,
  changeConversationStatusSchema,
  conversationTypingSchema,
  createConversationSchema,
  listConversationsQuerySchema,
} from "../validation/conversation.schemas";

/**
 * Conversation controller (FEATURES §19, §31–32, IMPLEMENTATION_PLAN step 15).
 *
 * Reads, status changes and staff replies are available to any member —
 * conversations are the operational work of the business. Status transitions
 * are validated by the backend-owned table (agent.md §19); a staff reply moves
 * the thread to HUMAN_ACTIVE and stops the AI (§32).
 */

function requireUserId(req: Request): string {
  const user = req.user;
  if (!user) {
    throw ApiError.unauthorized("UNAUTHENTICATED", "You need to sign in to continue.");
  }
  return user.id;
}

function conversationIdParam(req: Request): string {
  const conversationId = req.params.conversationId;
  if (typeof conversationId !== "string") {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  return conversationId;
}

/**
 * GET /api/v1/conversations — one business's conversations with filters +
 * pagination (§31), or all the caller's conversations when no ?businessId.
 */
export async function listConversations(req: Request, res: Response) {
  const userId = requireUserId(req);

  const parsed = listConversationsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    throw ApiError.badRequest(
      "VALIDATION_ERROR",
      field ? `${field}: ${issue?.message}` : (issue?.message ?? "Invalid query."),
    );
  }
  const query = parsed.data;

  if (query.businessId) {
    // Membership decides visibility — a foreign businessId yields 404 (§13).
    const page = await listConversationsForBusiness(userId, query, query.businessId);
    if (!page) {
      throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
    }
    res.json(
      apiSuccess({
        conversations: page.conversations,
        total: page.total,
        page: page.page,
        pageSize: page.pageSize,
      }),
    );
    return;
  }

  const conversations = await listConversationsForUser(userId, query);
  res.json(
    apiSuccess({
      conversations,
      total: conversations.length,
      page: query.page,
      pageSize: query.pageSize,
    }),
  );
}

/** GET /api/v1/conversations/:conversationId — member only (404 otherwise). */
export async function getConversation(req: Request, res: Response) {
  const userId = requireUserId(req);
  const conversation = await findConversationForUser(userId, conversationIdParam(req));

  if (!conversation) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(apiSuccess({ conversation }));
}

/** POST /api/v1/conversations — open a thread for an existing customer. */
export async function createConversation(req: Request, res: Response) {
  const userId = requireUserId(req);

  // Authorization before payload validation (§14): resolve the tenant from
  // the raw body first so an unauthorized caller can't probe validation.
  const rawBusinessId = (req.body as { businessId?: unknown } | null)?.businessId;
  if (typeof rawBusinessId !== "string" || rawBusinessId.length === 0) {
    throw ApiError.badRequest("VALIDATION_ERROR", "businessId: Business is required.");
  }
  await requireMembership(userId, rawBusinessId);

  const input = parseAfterAuth(createConversationSchema, req.body);

  const conversation = await createConversationForUser(userId, input);
  if (!conversation) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.status(201).json(apiSuccess({ conversation }));
}

/**
 * PATCH /api/v1/conversations/:conversationId/status — the only endpoint that
 * changes a conversation's status. Invalid jumps are rejected with
 * INVALID_TRANSITION so the UI can render valid actions (agent.md §19).
 */
export async function changeConversationStatus(req: Request, res: Response) {
  const userId = requireUserId(req);

  const existing = await findConversationForUser(userId, conversationIdParam(req));
  if (!existing) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  const input = parseAfterAuth(changeConversationStatusSchema, req.body);

  const result = await changeConversationStatusForUser(
    userId,
    existing.id,
    input.status,
  );

  if (!result.ok) {
    if (result.reason === "invalid_transition") {
      throw ApiError.badRequest(
        "INVALID_TRANSITION",
        `A conversation cannot move from ${existing.status} to ${input.status}.`,
      );
    }
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(apiSuccess({ conversation: result.conversation }));
}

/**
 * POST /api/v1/conversations/:conversationId/messages — a staff reply (§32).
 * The sender is always HUMAN; the thread moves to HUMAN_ACTIVE.
 */
export async function appendMessage(req: Request, res: Response) {
  const userId = requireUserId(req);

  const existing = await findConversationForUser(userId, conversationIdParam(req));
  if (!existing) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  const input = parseAfterAuth(appendMessageSchema, req.body);

  const result = await appendMessageForUser(userId, existing.id, input);
  if (!result) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res
    .status(201)
    .json(apiSuccess({ message: result.message, conversation: result.conversation }));
}

/**
 * POST /api/v1/conversations/:conversationId/typing — a staff member started or
 * stopped typing (§22). Nothing is stored; the flag is broadcast to the
 * business's dashboards and, for the visitor, read back on their next poll.
 * Returns 204 either way so the client never retries on a no-op.
 */
export async function setConversationTyping(req: Request, res: Response) {
  const userId = requireUserId(req);

  const existing = await findConversationForUser(userId, conversationIdParam(req));
  if (!existing) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  const input = parseAfterAuth(conversationTypingSchema, req.body ?? {});

  if (input.active === false) {
    clearTyping(existing.businessId, existing.id, "HUMAN");
  } else {
    setTyping(existing.businessId, existing.id, "HUMAN");
  }

  res.status(204).end();
}
