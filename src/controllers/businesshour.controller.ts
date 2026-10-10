import type { Request, Response } from "express";
import {
  createBusinessHourForUser,
  deleteBusinessHourForUser,
  findBusinessHourForUser,
  listBusinessHoursForBusiness,
  listBusinessHoursForUser,
  updateBusinessHourForUser,
} from "../repositories/businesshour.repository";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";
import {
  assertManageRole,
  parseAfterAuth,
  requireMembership,
} from "../utils/business-access";
import {
  createBusinessHourSchema,
  updateBusinessHourSchema,
  type BusinessHourDto,
  type CreateBusinessHourInput,
  type UpdateBusinessHourInput,
} from "../validation/businesshour.schemas";

/**
 * Safe business-hour DTO — only fields meant for the API (agent.md §26).
 * Availability comes from these rows or a connected calendar; the AI must
 * never invent available times (FEATURES §12, §25).
 */
function toBusinessHourDto(hour: BusinessHourDto) {
  return hour;
}

function requireUserId(req: Request): string {
  const user = req.user;
  if (!user) {
    throw ApiError.unauthorized("UNAUTHENTICATED", "You need to sign in to continue.");
  }
  return user.id;
}

function hourIdParam(req: Request): string {
  const hourId = req.params.hourId;
  if (typeof hourId !== "string") {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  return hourId;
}

function businessIdQuery(req: Request): string | undefined {
  const value = req.query.businessId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * GET /api/v1/hours — the caller's hours across their businesses, or just
 * one business's hours when ?businessId is supplied.
 */
export async function listBusinessHours(req: Request, res: Response) {
  const userId = requireUserId(req);
  const businessId = businessIdQuery(req);

  if (businessId) {
    await requireMembership(userId, businessId);
    const hours = await listBusinessHoursForBusiness(userId, businessId);
    res.json(
      apiSuccess({
        hours: hours.map((h) => ({ ...toBusinessHourDto(h), role: h.role })),
      }),
    );
    return;
  }

  const hours = await listBusinessHoursForUser(userId);
  res.json(
    apiSuccess({
      hours: hours.map((h) => ({ ...toBusinessHourDto(h), role: h.role })),
    }),
  );
}

/** POST /api/v1/hours — add hours. Non-members get 404, STAFF 403. */
export async function createBusinessHour(req: Request, res: Response) {
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

  const input = parseAfterAuth(createBusinessHourSchema, req.body);

  const hour = await createBusinessHourForUser(userId, rawBusinessId, input);
  if (!hour) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.status(201).json(
    apiSuccess({ hour: { ...toBusinessHourDto(hour), role: hour.role } }),
  );
}

/** GET /api/v1/hours/:hourId — verified members only (404 otherwise). */
export async function getBusinessHour(req: Request, res: Response) {
  const userId = requireUserId(req);
  const hour = await findBusinessHourForUser(userId, hourIdParam(req));

  if (!hour) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(
    apiSuccess({ hour: { ...toBusinessHourDto(hour), role: hour.role } }),
  );
}

/** PATCH /api/v1/hours/:hourId — OWNER/ADMIN only (404 then 403). */
export async function updateBusinessHour(req: Request, res: Response) {
  const userId = requireUserId(req);

  const existing = await findBusinessHourForUser(userId, hourIdParam(req));
  if (!existing) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  const membership = await requireMembership(userId, existing.businessId);
  assertManageRole(membership);

  const input = parseAfterAuth(updateBusinessHourSchema, req.body);

  const hour = await updateBusinessHourForUser(userId, existing.id, input);
  if (!hour) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(
    apiSuccess({ hour: { ...toBusinessHourDto(hour), role: hour.role } }),
  );
}

/** DELETE /api/v1/hours/:hourId — OWNER/ADMIN only (404 then 403). */
export async function deleteBusinessHour(req: Request, res: Response) {
  const userId = requireUserId(req);
  const hourId = hourIdParam(req);

  const existing = await findBusinessHourForUser(userId, hourId);
  if (!existing) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  const membership = await requireMembership(userId, existing.businessId);
  assertManageRole(membership);

  const hour = await deleteBusinessHourForUser(userId, hourId);
  if (!hour) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(
    apiSuccess({ hour: { ...toBusinessHourDto(hour), role: hour.role } }),
  );
}
