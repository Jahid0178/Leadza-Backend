import type { Request, Response } from "express";
import {
  archiveKnowledgeForUser,
  createKnowledgeForUser,
  findKnowledgeForUser,
  listKnowledgeForBusiness,
  listKnowledgeForUser,
  updateKnowledgeForUser,
} from "../repositories/knowledge.repository";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";
import {
  assertManageRole,
  parseAfterAuth,
  requireMembership,
} from "../utils/business-access";
import {
  createKnowledgeSchema,
  updateKnowledgeSchema,
  type CreateKnowledgeInput,
  type KnowledgeDto,
  type UpdateKnowledgeInput,
} from "../validation/knowledge.schemas";

/**
 * Safe knowledge-entry DTO — only fields meant for the API (agent.md §26),
 * so internals such as `archivedAt` never reach the client. Entries belong to
 * one business; the AI context builder loads only the current business's
 * published entries (FEATURES §13).
 */
function toKnowledgeDto(entry: KnowledgeDto) {
  const { id, businessId, question, answer, type, category, tags, isActive, createdAt, updatedAt } =
    entry;
  return { id, businessId, question, answer, type, category, tags, isActive, createdAt, updatedAt };
}

function requireUserId(req: Request): string {
  const user = req.user;
  if (!user) {
    throw ApiError.unauthorized("UNAUTHENTICATED", "You need to sign in to continue.");
  }
  return user.id;
}

function entryIdParam(req: Request): string {
  const entryId = req.params.entryId;
  if (typeof entryId !== "string") {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  return entryId;
}

function businessIdQuery(req: Request): string | undefined {
  const value = req.query.businessId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * GET /api/v1/knowledge — the caller's entries across their businesses, or
 * just one business's entries when ?businessId is supplied.
 */
export async function listKnowledge(req: Request, res: Response) {
  const userId = requireUserId(req);
  const businessId = businessIdQuery(req);

  if (businessId) {
    await requireMembership(userId, businessId);
    const entries = await listKnowledgeForBusiness(userId, businessId);
    res.json(
      apiSuccess({
        knowledge: entries.map((e) => ({ ...toKnowledgeDto(e), role: e.role })),
      }),
    );
    return;
  }

  const entries = await listKnowledgeForUser(userId);
  res.json(
    apiSuccess({
      knowledge: entries.map((e) => ({ ...toKnowledgeDto(e), role: e.role })),
    }),
  );
}

/**
 * POST /api/v1/knowledge — add an entry. Non-members get 404, STAFF 403.
 */
export async function createKnowledge(req: Request, res: Response) {
  const userId = requireUserId(req);

  // Authorization before payload validation (§14).
  const rawBusinessId = (req.body as { businessId?: unknown } | null)?.businessId;
  if (typeof rawBusinessId !== "string" || rawBusinessId.length === 0) {
    throw ApiError.badRequest(
      "VALIDATION_ERROR",
      "businessId: Business is required.",
    );
  }
  const membership = await requireMembership(userId, rawBusinessId);
  assertManageRole(membership);

  const input = parseAfterAuth(createKnowledgeSchema, req.body);

  const entry = await createKnowledgeForUser(userId, rawBusinessId, input);
  if (!entry) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.status(201).json(
    apiSuccess({ knowledge: { ...toKnowledgeDto(entry), role: entry.role } }),
  );
}

/** GET /api/v1/knowledge/:entryId — verified members only (404 otherwise). */
export async function getKnowledge(req: Request, res: Response) {
  const userId = requireUserId(req);
  const entry = await findKnowledgeForUser(userId, entryIdParam(req));

  if (!entry) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(
    apiSuccess({ knowledge: { ...toKnowledgeDto(entry), role: entry.role } }),
  );
}

/** PATCH /api/v1/knowledge/:entryId — OWNER/ADMIN only (404 then 403). */
export async function updateKnowledge(req: Request, res: Response) {
  const userId = requireUserId(req);

  const existing = await findKnowledgeForUser(userId, entryIdParam(req));
  if (!existing) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  const membership = await requireMembership(userId, existing.businessId);
  assertManageRole(membership);

  const input = parseAfterAuth(updateKnowledgeSchema, req.body);

  const entry = await updateKnowledgeForUser(userId, existing.id, input);
  if (!entry) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(
    apiSuccess({ knowledge: { ...toKnowledgeDto(entry), role: entry.role } }),
  );
}

/** DELETE /api/v1/knowledge/:entryId — archives the entry (OWNER/ADMIN). */
export async function archiveKnowledge(req: Request, res: Response) {
  const userId = requireUserId(req);
  const entryId = entryIdParam(req);

  const existing = await findKnowledgeForUser(userId, entryId);
  if (!existing) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  const membership = await requireMembership(userId, existing.businessId);
  assertManageRole(membership);

  const entry = await archiveKnowledgeForUser(userId, entryId);
  if (!entry) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(
    apiSuccess({ knowledge: { ...toKnowledgeDto(entry), role: entry.role } }),
  );
}
