import type { Request, Response } from "express";
import {
  createBusinessWithOwner,
  findBusinessForUser,
  listBusinessesForUser,
  markOnboardingCompleteForUser,
  updateBusinessForUser,
} from "../repositories/business.repository";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";
import type { CreateBusinessInput, UpdateBusinessInput } from "../validation/business.schemas";

/** Safe business DTO — only fields meant for the API (agent.md §26). */
function toBusinessDto(business: {
  id: string;
  name: string;
  type: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  description: string | null;
  latitude: number | null;
  longitude: number | null;
  status: string;
  onboardingCompletedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: business.id,
    name: business.name,
    type: business.type,
    website: business.website,
    phone: business.phone,
    email: business.email,
    address: business.address,
    description: business.description,
    latitude: business.latitude,
    longitude: business.longitude,
    status: business.status,
    onboardingCompletedAt: business.onboardingCompletedAt,
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
  res.json(
    apiSuccess({
      businesses: businesses.map((b) => ({ ...toBusinessDto(b), role: b.role })),
    }),
  );
}

/**
 * POST /api/v1/businesses — create a business; the caller becomes OWNER
 * atomically (FEATURES §9).
 */
export async function createBusiness(req: Request, res: Response) {
  const userId = requireUserId(req);
  const input = req.body as CreateBusinessInput;
  const business = await createBusinessWithOwner(userId, input);
  res.status(201).json(
    apiSuccess({ business: { ...toBusinessDto(business), role: "OWNER" as const } }),
  );
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
 * PATCH /api/v1/businesses/:businessId — role-gated profile update
 * (OWNER, ADMIN). The repository write carries the tenant scope; non-members
 * affect zero rows.
 */
export async function updateBusiness(req: Request, res: Response) {
  const userId = requireUserId(req);
  const input = req.body as UpdateBusinessInput;
  const business = await updateBusinessForUser(userId, businessIdParam(req), input);

  if (!business) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(apiSuccess({ business: toBusinessDto(business) }));
}

/**
 * POST /api/v1/businesses/:businessId/onboarding/complete — flips the
 * onboarding flag so the dashboard guard lets the business through (§9).
 */
export async function completeOnboarding(req: Request, res: Response) {
  const userId = requireUserId(req);
  const business = await markOnboardingCompleteForUser(userId, businessIdParam(req));

  if (!business) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(apiSuccess({ business: toBusinessDto(business) }));
}
