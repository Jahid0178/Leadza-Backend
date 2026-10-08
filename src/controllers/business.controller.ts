import type { Request, Response } from "express";
import {
  findBusinessForUser,
  listBusinessesForUser,
  updateBusinessForUser,
} from "../repositories/business.repository";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";
import type { UpdateBusinessInput } from "../validation/business.schemas";

/** Safe business DTO — only fields meant for the API (agent.md §26). */
function toBusinessDto(business: {
  id: string;
  name: string;
  status: string;
  createdAt: Date;
}) {
  return {
    id: business.id,
    name: business.name,
    status: business.status,
    createdAt: business.createdAt,
  };
}

function requireUserId(req: Request): string {
  const user = req.user;
  if (!user) {
    // requireAuth already rejects anonymous requests; defensive guard only.
    throw ApiError.unauthorized("UNAUTHENTICATED", "You need to sign in to continue.");
  }
  return user.id;
}

function businessIdParam(req: Request): string {
  const businessId = req.params.businessId;
  if (typeof businessId !== "string") {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  return businessId;
}

/** GET /api/v1/businesses — the caller's own businesses, scoped by membership. */
export async function listMyBusinesses(req: Request, res: Response) {
  const userId = requireUserId(req);
  const businesses = await listBusinessesForUser(userId);
  res.json(apiSuccess({ businesses: businesses.map((b) => ({ ...toBusinessDto(b), role: b.role })) }));
}

/** GET /api/v1/businesses/:businessId — verified members only (404 otherwise). */
export async function getBusiness(req: Request, res: Response) {
  const userId = requireUserId(req);
  const business = await findBusinessForUser(userId, businessIdParam(req));

  if (!business) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(apiSuccess({ business: toBusinessDto(business) }));
}

/**
 * PATCH /api/v1/businesses/:businessId — role-gated update (OWNER, ADMIN).
 * The repository write carries the tenant scope; non-members affect zero rows.
 */
export async function updateBusiness(req: Request, res: Response) {
  const userId = requireUserId(req);
  const input = req.body as UpdateBusinessInput;
  const business = await updateBusinessForUser(userId, businessIdParam(req), {
    name: input.name,
  });

  if (!business) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(apiSuccess({ business: toBusinessDto(business) }));
}
