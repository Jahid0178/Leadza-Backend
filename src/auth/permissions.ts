import type { NextFunction, Request, Response } from "express";
import { findMembership } from "../repositories/membership.repository";
import { ApiError } from "../utils/api-error";
import type { MemberRole, SessionUser } from "./types";

/**
 * Authorization core (agent.md §6, §34, §Platform Admin Security).
 * Authentication lives in middleware.ts; every *authorization decision* routes
 * through this module so status semantics stay consistent (§26):
 *
 *   401 UNAUTHENTICATED                — no valid session
 *   403 PLATFORM_ADMIN_REQUIRED / ROLE_REQUIRED — signed in, insufficient rights
 *   404 NOT_FOUND                      — resource missing OR caller has no
 *                                        membership (never leak another
 *                                        tenant's resource existence, §13)
 */

/** Platform-admin check (FEATURES §5). Programmatic form used by middleware. */
export function assertPlatformAdmin(user: SessionUser | undefined): void {
  if (user?.platformRole !== "PLATFORM_ADMIN") {
    throw ApiError.forbidden(
      "PLATFORM_ADMIN_REQUIRED",
      "Platform administrator access is required.",
    );
  }
}

/**
 * Resolves and verifies business membership for the route's `:businessId`
 * parameter. Must run after `requireAuth`.
 *
 * On success attaches the *verified* membership to `req.membership`; callers
 * with no membership get the same 404 as a missing resource, so a business id
 * from another tenant is indistinguishable from a non-existent one (§13).
 */
export function resolveMembership(param = "businessId") {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) {
      // Route misconfigured: resolveMembership without requireAuth first.
      throw ApiError.unauthorized("UNAUTHENTICATED", "You need to sign in to continue.");
    }

    const businessId = req.params[param];
    if (typeof businessId !== "string") {
      throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
    }

    const membership = await findMembership(user.id, businessId);
    if (!membership) {
      throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
    }

    req.membership = membership;
    next();
  };
}

/**
 * Role gate for routes behind `resolveMembership` (agent.md §6, §44).
 * Reads the membership the backend verified — never a client-supplied role.
 * Use the explicit role list: no hidden OWNER > ADMIN > STAFF hierarchy.
 */
export function requireRole(...roles: MemberRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const membership = req.membership;
    if (!membership) {
      // Programming error: requireRole used without resolveMembership upstream.
      throw ApiError.internal("AUTHZ_NOT_RESOLVED", "Something went wrong. Please try again.");
    }

    if (!roles.includes(membership.role)) {
      throw ApiError.forbidden("ROLE_REQUIRED", "You do not have permission to do that.");
    }

    next();
  };
}
