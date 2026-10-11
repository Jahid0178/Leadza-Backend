import type { Request, Response } from "express";
import {
  archiveServiceForUser,
  createServiceForUser,
  findServiceForUser,
  listServicesForBusiness,
  listServicesForUser,
  updateServiceForUser,
} from "../repositories/service.repository";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";
import {
  assertManageRole,
  parseAfterAuth,
  requireMembership,
} from "../utils/business-access";
import {
  createServiceSchema,
  updateServiceSchema,
  type CreateServiceInput,
  type ServiceDto,
  type UpdateServiceInput,
} from "../validation/service.schemas";

/**
 * Safe service DTO — only fields meant for the API (agent.md §26).
 * Pricing and duration come from this table; the AI must never invent them
 * (FEATURES §25).
 */
function toServiceDto(service: ServiceDto) {
  return service;
}

function requireUserId(req: Request): string {
  const user = req.user;
  if (!user) {
    // requireAuth already rejects anonymous requests; defensive guard only.
    throw ApiError.unauthorized("UNAUTHENTICATED", "You need to sign in to continue.");
  }
  return user.id;
}

function serviceIdParam(req: Request): string {
  const serviceId = req.params.serviceId;
  if (typeof serviceId !== "string") {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  return serviceId;
}

function businessIdQuery(req: Request): string | undefined {
  const value = req.query.businessId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * GET /api/v1/services — the caller's services across their businesses, or
 * just one business's services when ?businessId is supplied.
 */
export async function listServices(req: Request, res: Response) {
  const userId = requireUserId(req);
  const businessId = businessIdQuery(req);

  if (businessId) {
    // Membership decides visibility — a foreign businessId yields 404 (§13).
    await requireMembership(userId, businessId);
    const services = await listServicesForBusiness(userId, businessId);
    res.json(
      apiSuccess({
        services: services.map((s) => ({ ...toServiceDto(s), role: s.role })),
      }),
    );
    return;
  }

  const services = await listServicesForUser(userId);
  res.json(
    apiSuccess({
      services: services.map((s) => ({ ...toServiceDto(s), role: s.role })),
    }),
  );
}

/**
 * POST /api/v1/services — create a service. The businessId must resolve to a
 * membership with OWNER/ADMIN: non-members get 404, STAFF gets 403.
 */
export async function createService(req: Request, res: Response) {
  const userId = requireUserId(req);

  // Authorization runs before payload validation (§14): resolve the tenant
  // from the raw body first so an unauthorized caller can't probe validation.
  const rawBusinessId = (req.body as { businessId?: unknown } | null)?.businessId;
  if (typeof rawBusinessId !== "string" || rawBusinessId.length === 0) {
    throw ApiError.badRequest(
      "VALIDATION_ERROR",
      "businessId: Business is required.",
    );
  }
  const membership = await requireMembership(userId, rawBusinessId);
  assertManageRole(membership);

  const input = parseAfterAuth(createServiceSchema, req.body);

  const service = await createServiceForUser(userId, input.businessId, input);

  if (!service) {
    // Defensive: membership re-check inside the repository disagreed.
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.status(201).json(
    apiSuccess({ service: { ...toServiceDto(service), role: service.role } }),
  );
}

/** GET /api/v1/services/:serviceId — verified members only (404 otherwise). */
export async function getService(req: Request, res: Response) {
  const userId = requireUserId(req);
  const service = await findServiceForUser(userId, serviceIdParam(req));

  if (!service) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(
    apiSuccess({ service: { ...toServiceDto(service), role: service.role } }),
  );
}

/**
 * PATCH /api/v1/services/:serviceId — OWNER/ADMIN only.
 * Membership resolves first (404), then role (403), then validation ran in
 * the route middleware.
 */
export async function updateService(req: Request, res: Response) {
  const userId = requireUserId(req);

  const existing = await findServiceForUser(userId, serviceIdParam(req));
  if (!existing) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  const membership = await requireMembership(userId, existing.businessId);
  assertManageRole(membership);

  const input = parseAfterAuth(updateServiceSchema, req.body);

  const service = await updateServiceForUser(userId, existing.id, input);
  if (!service) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(
    apiSuccess({ service: { ...toServiceDto(service), role: service.role } }),
  );
}

/**
 * DELETE /api/v1/services/:serviceId — soft delete by flipping active=false,
 * OWNER/ADMIN only.
 */
export async function archiveService(req: Request, res: Response) {
  const userId = requireUserId(req);
  const serviceId = serviceIdParam(req);

  const existing = await findServiceForUser(userId, serviceId);
  if (!existing) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  const membership = await requireMembership(userId, existing.businessId);
  assertManageRole(membership);

  const service = await archiveServiceForUser(userId, serviceId);
  if (!service) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(
    apiSuccess({ service: { ...toServiceDto(service), role: service.role } }),
  );
}
