import { ApiError } from "../utils/api-error";

/**
 * Platform-owned business lifecycle (FEATURES §42–43, IMPLEMENTATION_PLAN
 * step 28).
 *
 * A **SUSPENDED** business is out of service, not merely flagged:
 *   - the public capture paths already refuse it (403 BUSINESS_SUSPENDED),
 *   - every authenticated business-scoped API refuses it as well — the check
 *     rides on `findMembership`, the single place tenancy is proven, so no
 *     route can forget it,
 *   - the AI reply queue does not answer for it.
 *
 * The business's own record stays readable through `GET /businesses` so the
 * dashboard can explain *why* nothing else works (the frontend redirects to
 * `/suspended`). Restoration is a platform-admin action (§42).
 */

export type BusinessStatus = "ACTIVE" | "SUSPENDED";

export const BUSINESS_SUSPENDED_CODE = "BUSINESS_SUSPENDED";
export const BUSINESS_SUSPENDED_MESSAGE =
  "This business is suspended. Contact platform support to restore it.";

/** Only an ACTIVE business is serviceable. */
export function isBusinessServiceable(status: string): boolean {
  return status === "ACTIVE";
}

/** Throws 403 BUSINESS_SUSPENDED for anything but an ACTIVE business. */
export function assertBusinessServiceable(business: { status: string }): void {
  if (!isBusinessServiceable(business.status)) {
    throw ApiError.forbidden(BUSINESS_SUSPENDED_CODE, BUSINESS_SUSPENDED_MESSAGE);
  }
}
