import type {
  CreateServiceAreaInput,
  ServiceAreaDto,
  UpdateServiceAreaInput,
} from "../validation/servicearea.schemas";
import { prisma } from "../lib/prisma";
import { findMembership } from "./membership.repository";

/** A service area plus the caller's role for API responses. */
export interface ServiceAreaWithRole extends ServiceAreaDto {
  role: "OWNER" | "ADMIN" | "STAFF";
}

/**
 * Tenant-scoped service-area access (FEATURES §11, agent.md §13).
 * Every function verifies membership with the authenticated userId before
 * touching the row, so a businessId never comes from the client.
 */

/** Caller's businessId → verified role, resolved server-side. */
async function membershipRolesForUser(userId: string) {
  const memberships = await prisma.businessMember.findMany({
    where: { userId },
    select: { businessId: true, role: true },
  });
  return new Map(memberships.map((m) => [m.businessId, m.role]));
}

/** List service areas across all the caller's businesses. */
export async function listServiceAreasForUser(
  userId: string,
): Promise<ServiceAreaWithRole[]> {
  const roles = await membershipRolesForUser(userId);
  if (roles.size === 0) return [];

  const areas = await prisma.serviceArea.findMany({
    where: { businessId: { in: [...roles.keys()] } },
    orderBy: { value: "asc" },
  });

  const rows = areas.map((area) => {
    const role = roles.get(area.businessId);
    return role ? ({ ...area, role } as ServiceAreaWithRole) : null;
  });

  return rows.filter((r): r is ServiceAreaWithRole => r !== null);
}

/** List service areas for one business the caller belongs to. */
export async function listServiceAreasForBusiness(
  userId: string,
  businessId: string,
): Promise<ServiceAreaWithRole[]> {
  const membership = await findMembership(userId, businessId);
  if (!membership) return [];

  const areas = await prisma.serviceArea.findMany({
    where: { businessId },
    orderBy: { value: "asc" },
  });

  return areas.map((area) => ({ ...area, role: membership.role }));
}

/** Read one service area if the caller is a member of its business. */
export async function findServiceAreaForUser(
  userId: string,
  areaId: string,
): Promise<ServiceAreaWithRole | null> {
  const area = await prisma.serviceArea.findUnique({ where: { id: areaId } });
  if (!area) return null;

  const membership = await findMembership(userId, area.businessId);
  if (!membership) return null;

  return { ...area, role: membership.role };
}

/** Create a service area for a business the caller owns or admins. */
export async function createServiceAreaForUser(
  userId: string,
  businessId: string,
  data: CreateServiceAreaInput,
): Promise<ServiceAreaWithRole | null> {
  const membership = await findMembership(userId, businessId);
  if (!membership || (membership.role !== "OWNER" && membership.role !== "ADMIN")) {
    return null;
  }

  const area = await prisma.serviceArea.create({
    data: { ...data, businessId },
  });

  return { ...area, role: membership.role };
}

/** Update a service area if the caller is an OWNER or ADMIN. */
export async function updateServiceAreaForUser(
  userId: string,
  areaId: string,
  data: UpdateServiceAreaInput,
): Promise<ServiceAreaWithRole | null> {
  const area = await prisma.serviceArea.findUnique({ where: { id: areaId } });
  if (!area) return null;

  const membership = await findMembership(userId, area.businessId);
  if (!membership || (membership.role !== "OWNER" && membership.role !== "ADMIN")) {
    return null;
  }

  const updated = await prisma.serviceArea.update({
    where: { id: areaId },
    data,
  });

  return { ...updated, role: membership.role };
}

/** Delete a service area if the caller is an OWNER or ADMIN. */
export async function deleteServiceAreaForUser(
  userId: string,
  areaId: string,
): Promise<ServiceAreaWithRole | null> {
  const area = await prisma.serviceArea.findUnique({ where: { id: areaId } });
  if (!area) return null;

  const membership = await findMembership(userId, area.businessId);
  if (!membership || (membership.role !== "OWNER" && membership.role !== "ADMIN")) {
    return null;
  }

  const deleted = await prisma.serviceArea.delete({ where: { id: areaId } });

  return { ...deleted, role: membership.role };
}
