import type { BusinessMember } from "../../generated/prisma/client";
import { prisma } from "../lib/prisma";

/**
 * Membership data access (agent.md §11, §6).
 * Membership is the only proof of tenancy — the backend resolves it from the
 * authenticated userId, never from a client-supplied value.
 */
export async function findMembership(
  userId: string,
  businessId: string,
): Promise<BusinessMember | null> {
  return prisma.businessMember.findUnique({
    where: { businessId_userId: { businessId, userId } },
  });
}
