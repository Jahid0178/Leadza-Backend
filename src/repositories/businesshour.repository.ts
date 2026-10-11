import type {
  BusinessHourDto,
  CreateBusinessHourInput,
  UpdateBusinessHourInput,
} from "../validation/businesshour.schemas";
import { prisma } from "../lib/prisma";
import { findMembership } from "./membership.repository";

/** A business hour plus the caller's role for API responses. */
export interface BusinessHourWithRole extends BusinessHourDto {
  role: "OWNER" | "ADMIN" | "STAFF";
}

/**
 * Tenant-scoped business-hours access (FEATURES §12, agent.md §13).
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

/** List business hours across all the caller's businesses. */
export async function listBusinessHoursForUser(
  userId: string,
): Promise<BusinessHourWithRole[]> {
  const roles = await membershipRolesForUser(userId);
  if (roles.size === 0) return [];

  const hours = await prisma.businessHour.findMany({
    where: { businessId: { in: [...roles.keys()] } },
    orderBy: [{ weekday: "asc" }, { orderIndex: "asc" }],
  });

  const rows = hours.map((hour) => {
    const role = roles.get(hour.businessId);
    return role ? ({ ...hour, role } as BusinessHourWithRole) : null;
  });

  return rows.filter((r): r is BusinessHourWithRole => r !== null);
}

/** List hours for one business the caller belongs to. */
export async function listBusinessHoursForBusiness(
  userId: string,
  businessId: string,
): Promise<BusinessHourWithRole[]> {
  const membership = await findMembership(userId, businessId);
  if (!membership) return [];

  const hours = await prisma.businessHour.findMany({
    where: { businessId },
    orderBy: [{ weekday: "asc" }, { orderIndex: "asc" }],
  });

  return hours.map((hour) => ({ ...hour, role: membership.role }));
}

/** Read one business hour if the caller is a member of its business. */
export async function findBusinessHourForUser(
  userId: string,
  hourId: string,
): Promise<BusinessHourWithRole | null> {
  const hour = await prisma.businessHour.findUnique({ where: { id: hourId } });
  if (!hour) return null;

  const membership = await findMembership(userId, hour.businessId);
  if (!membership) return null;

  return { ...hour, role: membership.role };
}

/** Create a business hour for a business the caller owns or admins. */
export async function createBusinessHourForUser(
  userId: string,
  businessId: string,
  data: CreateBusinessHourInput,
): Promise<BusinessHourWithRole | null> {
  const membership = await findMembership(userId, businessId);
  if (!membership || (membership.role !== "OWNER" && membership.role !== "ADMIN")) {
    return null;
  }

  const hour = await prisma.businessHour.create({
    data: { ...data, businessId },
  });

  return { ...hour, role: membership.role };
}

/** Update a business hour if the caller is an OWNER or ADMIN. */
export async function updateBusinessHourForUser(
  userId: string,
  hourId: string,
  data: UpdateBusinessHourInput,
): Promise<BusinessHourWithRole | null> {
  const hour = await prisma.businessHour.findUnique({ where: { id: hourId } });
  if (!hour) return null;

  const membership = await findMembership(userId, hour.businessId);
  if (!membership || (membership.role !== "OWNER" && membership.role !== "ADMIN")) {
    return null;
  }

  const updated = await prisma.businessHour.update({
    where: { id: hourId },
    data,
  });

  return { ...updated, role: membership.role };
}

/** Delete a business hour if the caller is an OWNER or ADMIN. */
export async function deleteBusinessHourForUser(
  userId: string,
  hourId: string,
): Promise<BusinessHourWithRole | null> {
  const hour = await prisma.businessHour.findUnique({ where: { id: hourId } });
  if (!hour) return null;

  const membership = await findMembership(userId, hour.businessId);
  if (!membership || (membership.role !== "OWNER" && membership.role !== "ADMIN")) {
    return null;
  }

  const deleted = await prisma.businessHour.delete({ where: { id: hourId } });

  return { ...deleted, role: membership.role };
}
