import type { Business } from "../../generated/prisma/client";
import { prisma } from "../lib/prisma";
import type { CreateBusinessInput } from "../validation/business.schemas";

/**
 * Tenant-scoped business data access (agent.md §13, FEATURES §7).
 * Every function takes the *authenticated* userId and embeds the membership
 * constraint in the WHERE clause — there is no unscoped `WHERE id = ?` lookup
 * to reach by accident, and `businessId` never comes from the client.
 */

/** Profile fields accepted by PATCH (FEATURES §8). */
export interface BusinessProfilePatch {
  name?: string;
  type?: string | null;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  description?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

/** A business plus the caller's own membership role, for API responses. */
export interface BusinessWithRole extends Business {
  role: "OWNER" | "ADMIN" | "STAFF";
}

/**
 * Creates a business and the caller's OWNER membership atomically
 * (FEATURES §9: create account → create business → create OWNER membership).
 */
export async function createBusinessWithOwner(
  userId: string,
  input: CreateBusinessInput,
): Promise<Business> {
  return prisma.$transaction(async (tx) => {
    const business = await tx.business.create({
      data: { name: input.name, type: input.type ?? null },
    });
    await tx.businessMember.create({
      data: { businessId: business.id, userId, role: "OWNER" },
    });
    return business;
  });
}

export async function listBusinessesForUser(userId: string): Promise<BusinessWithRole[]> {
  const businesses = await prisma.business.findMany({
    where: { members: { some: { userId } } },
    include: {
      members: { where: { userId }, select: { role: true }, take: 1 },
    },
    orderBy: { createdAt: "asc" },
  });

  return businesses.flatMap(({ members, ...business }) => {
    const role = members[0]?.role;
    return role ? [{ ...business, role }] : [];
  });
}

export async function findBusinessForUser(
  userId: string,
  businessId: string,
): Promise<Business | null> {
  return prisma.business.findFirst({
    where: { id: businessId, members: { some: { userId } } },
  });
}

/**
 * Tenant-scoped update: the membership constraint rides along in the WHERE
 * clause, so a non-member's write affects zero rows and reports null.
 */
export async function updateBusinessForUser(
  userId: string,
  businessId: string,
  data: BusinessProfilePatch,
): Promise<Business | null> {
  const result = await prisma.business.updateMany({
    where: { id: businessId, members: { some: { userId } } },
    data,
  });

  if (result.count === 0) return null;
  return findBusinessForUser(userId, businessId);
}

/** Marks onboarding complete (tenant-scoped like every other write, §13). */
export async function markOnboardingCompleteForUser(
  userId: string,
  businessId: string,
): Promise<Business | null> {
  const result = await prisma.business.updateMany({
    where: { id: businessId, members: { some: { userId } } },
    data: { onboardingCompletedAt: new Date() },
  });

  if (result.count === 0) return null;
  return findBusinessForUser(userId, businessId);
}
