import { findMembership } from "../repositories/membership.repository";
import { ApiError } from "./api-error";
import type { MemberRole } from "../auth/types";
import type { ZodType } from "zod";

/**
 * Shared business-access checks for business-owned resources
 * (agent.md §6, §13, FEATURES §7).
 *
 * Status semantics stay consistent everywhere:
 *   404 NOT_FOUND        — no membership (never leak another tenant's
 *                          resource existence)
 *   403 ROLE_REQUIRED    — member, but not OWNER/ADMIN for a mutation
 *
 * Validation runs *after* authorization (§14): an unauthorized caller must
 * get 404/403 regardless of how well-formed their payload is.
 */
export async function requireMembership(userId: string, businessId: string) {
  const membership = await findMembership(userId, businessId);
  if (!membership) {
    throw ApiError.notFound(
      "NOT_FOUND",
      "The requested resource was not found.",
    );
  }
  return membership;
}

/** OWNER/ADMIN only — throws 403 for STAFF. Call after requireMembership. */
export function assertManageRole(membership: { role: MemberRole }) {
  if (membership.role !== "OWNER" && membership.role !== "ADMIN") {
    throw ApiError.forbidden(
      "ROLE_REQUIRED",
      "You do not have permission to do that.",
    );
  }
}

/**
 * Validate a payload after authorization. Mirrors validateBody's error
 * envelope (§53) so callers can't tell whether authz or validation ran
 * first by payload shape alone.
 */
export function parseAfterAuth<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const field = issue?.path.join(".");
  const message = !issue
    ? "Invalid input."
    : field
      ? `${field}: ${issue.message}`
      : issue.message;
  throw ApiError.badRequest("VALIDATION_ERROR", message);
}
