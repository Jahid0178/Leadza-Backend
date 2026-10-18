import type { BusinessMember } from "../../generated/prisma/client";
import { assertBusinessServiceable } from "../services/business-status";
import { prisma } from "../lib/prisma";

/**
 * Membership data access (agent.md §11, §6).
 * Membership is the only proof of tenancy — the backend resolves it from the
 * authenticated userId, never from a client-supplied value.
 *
 * This is also where the **business serviceability rule** is enforced
 * (FEATURES §42–43, IMPLEMENTATION_PLAN step 28): every authenticated
 * business-scoped repository, controller helper and route guard proves tenancy
 * through `findMembership`, so a suspended business is refused here once —
 * with 403 BUSINESS_SUSPENDED — instead of being re-checked (and eventually
 * forgotten) per route. A caller with no membership still gets `null`, so the
 * "never leak another tenant's existence" rule (§13 → 404) is unchanged.
 */
export async function findMembership(
  userId: string,
  businessId: string,
): Promise<BusinessMember | null> {
  const membership = await prisma.businessMember.findUnique({
    where: { businessId_userId: { businessId, userId } },
    include: { business: { select: { status: true } } },
  });

  if (!membership) return null;

  const { business, ...fields } = membership;
  assertBusinessServiceable(business);

  return fields;
}
