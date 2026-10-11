import type { Request, Response } from "express";
import {
  changeLeadStatusForUser,
  createLeadForUser,
  findLeadForUser,
  listLeadsForBusiness,
  listLeadsForUser,
  updateLeadForUser,
} from "../repositories/lead.repository";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";
import { parseAfterAuth, requireMembership } from "../utils/business-access";
import {
  changeLeadStatusSchema,
  createLeadSchema,
  leadStatusSchema,
  listLeadsQuerySchema,
  updateLeadSchema,
  type LeadDto,
} from "../validation/lead.schemas";

/**
 * Lead controller (FEATURES §15–17, §29–30, IMPLEMENTATION_PLAN step 14).
 *
 * Reads and status changes are available to any member — leads are the
 * operational work of the business, not privileged configuration (Phase C
 * exit: a human can enter a lead and change statuses manually). Status
 * transitions are validated by the backend-owned table (agent.md §19); the
 * frontend may never jump a lead to an arbitrary state.
 */

function requireUserId(req: Request): string {
  const user = req.user;
  if (!user) {
    throw ApiError.unauthorized("UNAUTHENTICATED", "You need to sign in to continue.");
  }
  return user.id;
}

function leadIdParam(req: Request): string {
  const leadId = req.params.leadId;
  if (typeof leadId !== "string") {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  return leadId;
}

/** Safe lead DTO — only fields meant for the API (agent.md §26). */
function toLeadDto(lead: LeadDto) {
  return lead;
}

/**
 * GET /api/v1/leads — one business's leads with filters + pagination
 * (§29), or all the caller's leads when no ?businessId is supplied.
 */
export async function listLeads(req: Request, res: Response) {
  const userId = requireUserId(req);

  const parsed = listLeadsQuerySchema.safeParse(req.query);
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
    const page = await listLeadsForBusiness(userId, query, query.businessId);
    if (!page) {
      throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
    }
    res.json(
      apiSuccess({
        leads: page.leads,
        total: page.total,
        page: page.page,
        pageSize: page.pageSize,
      }),
    );
    return;
  }

  const leads = await listLeadsForUser(userId, query);
  res.json(
    apiSuccess({
      leads,
      total: leads.length,
      page: query.page,
      pageSize: query.pageSize,
    }),
  );
}

/** GET /api/v1/leads/:leadId — verified members only (404 otherwise). */
export async function getLead(req: Request, res: Response) {
  const userId = requireUserId(req);
  const lead = await findLeadForUser(userId, leadIdParam(req));

  if (!lead) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(apiSuccess({ lead }));
}

/**
 * POST /api/v1/leads — create a lead (manual entry, §30 "a human can
 * already use the product manually"). The customer must belong to the same
 * business; cross-tenant ids answer 404 (§13).
 */
export async function createLead(req: Request, res: Response) {
  const userId = requireUserId(req);

  // Authorization before payload validation (§14): resolve the tenant from
  // the raw body first so an unauthorized caller can't probe validation.
  const rawBusinessId = (req.body as { businessId?: unknown } | null)?.businessId;
  if (typeof rawBusinessId !== "string" || rawBusinessId.length === 0) {
    throw ApiError.badRequest("VALIDATION_ERROR", "businessId: Business is required.");
  }
  await requireMembership(userId, rawBusinessId);

  const input = parseAfterAuth(createLeadSchema, req.body);

  const lead = await createLeadForUser(userId, input);
  if (!lead) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.status(201).json(apiSuccess({ lead }));
}

/** PATCH /api/v1/leads/:leadId — qualification fields (never status). */
export async function updateLead(req: Request, res: Response) {
  const userId = requireUserId(req);

  const existing = await findLeadForUser(userId, leadIdParam(req));
  if (!existing) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  const input = parseAfterAuth(updateLeadSchema, req.body);

  const lead = await updateLeadForUser(userId, existing.id, input);
  if (!lead) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(apiSuccess({ lead }));
}

/**
 * PATCH /api/v1/leads/:leadId/status — the only endpoint that changes a
 * lead's status. Invalid jumps are rejected with INVALID_TRANSITION and the
 * allowed next statuses, so the UI can render valid actions (agent.md §19).
 */
export async function changeLeadStatus(req: Request, res: Response) {
  const userId = requireUserId(req);

  const existing = await findLeadForUser(userId, leadIdParam(req));
  if (!existing) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  const input = parseAfterAuth(changeLeadStatusSchema, req.body);

  const result = await changeLeadStatusForUser(userId, existing.id, input.status);

  if (!result.ok) {
    if (result.reason === "invalid_transition") {
      throw ApiError.badRequest(
        "INVALID_TRANSITION",
        `A lead cannot move from ${existing.status} to ${input.status}.`,
      );
    }
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(apiSuccess({ lead: result.lead }));
}

/** Exposed for tests: all statuses the zod schema accepts. */
export { leadStatusSchema };
