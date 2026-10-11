import type { Request, Response } from "express";
import {
  createServiceAreaForUser,
  deleteServiceAreaForUser,
  findServiceAreaForUser,
  listServiceAreasForBusiness,
  listServiceAreasForUser,
  updateServiceAreaForUser,
} from "../repositories/servicearea.repository";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";
import {
  assertManageRole,
  parseAfterAuth,
  requireMembership,
} from "../utils/business-access";
import {
  createServiceAreaSchema,
  updateServiceAreaSchema,
  type CreateServiceAreaInput,
  type ServiceAreaDto,
  type UpdateServiceAreaInput,
} from "../validation/servicearea.schemas";

/**
 * Safe service-area DTO — only fields meant for the API (agent.md §26).
 * The AI may use areas to judge whether a lead can be served; it never
 * fabricates coverage (FEATURES §11, §25).
 */
function toServiceAreaDto(area: ServiceAreaDto) {
  return area;
}

function requireUserId(req: Request): string {
  const user = req.user;
  if (!user) {
    throw ApiError.unauthorized("UNAUTHENTICATED", "You need to sign in to continue.");
  }
  return user.id;
}

function areaIdParam(req: Request): string {
  const areaId = req.params.areaId;
  if (typeof areaId !== "string") {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  return areaId;
}

function businessIdQuery(req: Request): string | undefined {
  const value = req.query.businessId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * GET /api/v1/areas — the caller's areas across their businesses, or just
 * one business's areas when ?businessId is supplied.
 */
export async function listServiceAreas(req: Request, res: Response) {
  const userId = requireUserId(req);
  const businessId = businessIdQuery(req);

  if (businessId) {
    await requireMembership(userId, businessId);
    const areas = await listServiceAreasForBusiness(userId, businessId);
    res.json(
      apiSuccess({
        areas: areas.map((a) => ({ ...toServiceAreaDto(a), role: a.role })),
      }),
    );
    return;
  }

  const areas = await listServiceAreasForUser(userId);
  res.json(
    apiSuccess({
      areas: areas.map((a) => ({ ...toServiceAreaDto(a), role: a.role })),
    }),
  );
}

/**
 * POST /api/v1/areas — add a service area. Non-members get 404, STAFF 403.
 */
export async function createServiceArea(req: Request, res: Response) {
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

  const input = parseAfterAuth(createServiceAreaSchema, req.body);

  const area = await createServiceAreaForUser(userId, rawBusinessId, input);
  if (!area) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.status(201).json(
    apiSuccess({ area: { ...toServiceAreaDto(area), role: area.role } }),
  );
}

/** GET /api/v1/areas/:areaId — verified members only (404 otherwise). */
export async function getServiceArea(req: Request, res: Response) {
  const userId = requireUserId(req);
  const area = await findServiceAreaForUser(userId, areaIdParam(req));

  if (!area) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(
    apiSuccess({ area: { ...toServiceAreaDto(area), role: area.role } }),
  );
}

/** PATCH /api/v1/areas/:areaId — OWNER/ADMIN only (404 then 403). */
export async function updateServiceArea(req: Request, res: Response) {
  const userId = requireUserId(req);

  const existing = await findServiceAreaForUser(userId, areaIdParam(req));
  if (!existing) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  const membership = await requireMembership(userId, existing.businessId);
  assertManageRole(membership);

  const input = parseAfterAuth(updateServiceAreaSchema, req.body);

  const area = await updateServiceAreaForUser(userId, existing.id, input);
  if (!area) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(
    apiSuccess({ area: { ...toServiceAreaDto(area), role: area.role } }),
  );
}

/** DELETE /api/v1/areas/:areaId — OWNER/ADMIN only (404 then 403). */
export async function deleteServiceArea(req: Request, res: Response) {
  const userId = requireUserId(req);
  const areaId = areaIdParam(req);

  const existing = await findServiceAreaForUser(userId, areaId);
  if (!existing) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  const membership = await requireMembership(userId, existing.businessId);
  assertManageRole(membership);

  const area = await deleteServiceAreaForUser(userId, areaId);
  if (!area) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(
    apiSuccess({ area: { ...toServiceAreaDto(area), role: area.role } }),
  );
}
