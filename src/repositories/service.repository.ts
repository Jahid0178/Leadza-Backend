import type {
  CreateServiceInput,
  ServiceDto,
  ServiceWhereUniqueInput,
  UpdateServiceInput,
} from "../validation/service.schemas";
import { prisma } from "../lib/prisma";
import { findMembership } from "./membership.repository";

/** A service plus the caller's role for API responses. */
export interface ServiceWithRole extends ServiceDto {
  role: "OWNER" | "ADMIN" | "STAFF";
}

/**
 * Tenant-scoped service access (FEATURES §10, agent.md §13).
 * Every authenticated function verifies membership with the userId before
 * touching the row, so a businessId never comes from the client. The one
 * exception is findPublicActiveService() below, which serves the anonymous
 * website embeds whose businessId is the server-resolved ref of an ACTIVE
 * business (§21–22).
 */

/** List services the caller can see, with their role on each. */
export async function listServicesForUser(
  userId: string,
): Promise<ServiceWithRole[]> {
  const memberships = await prisma.businessMember.findMany({
    where: { userId },
    include: {
      business: {
        include: {
          services: true,
        },
      },
    },
  });

  const rows: ServiceWithRole[] = [];
  for (const membership of memberships) {
    for (const service of membership.business.services) {
      rows.push({
        ...service as ServiceDto,
        role: membership.role,
      });
    }
  }

  return rows.sort((a, b) => a.businessId.localeCompare(b.businessId));
}

/** List services for one business the caller belongs to. */
export async function listServicesForBusiness(
  userId: string,
  businessId: string,
): Promise<ServiceWithRole[]> {
  const membership = await findMembership(userId, businessId);
  if (!membership) return [];

  const services = await prisma.service.findMany({
    where: { businessId },
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });

  return services.map((service) => ({ ...service, role: membership.role }));
}

/** Read one service if the caller is a member of its business. */
export async function findServiceForUser(
  userId: string,
  serviceId: string,
): Promise<ServiceWithRole | null> {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
  });
  if (!service) return null;

  const membership = await findMembership(userId, service.businessId);
  if (!membership) return null;

  return { ...service, role: membership.role };
}

/** Create a service for a business the caller owns or admins. */
export async function createServiceForUser(
  userId: string,
  businessId: string,
  data: CreateServiceInput,
): Promise<ServiceWithRole | null> {
  const membership = await findMembership(userId, businessId);
  if (!membership || !["OWNER", "ADMIN"].includes(membership.role)) {
    return null;
  }

  const service = await prisma.service.create({
    data: { ...data, businessId },
  });

  return { ...service as ServiceDto, role: membership.role };
}

/** Update a service if the caller is an OWNER or ADMIN of its business. */
export async function updateServiceForUser(
  userId: string,
  serviceId: string,
  data: UpdateServiceInput,
): Promise<ServiceWithRole | null> {
  const service = await prisma.service.findUnique({ where: { id: serviceId } });
  if (!service) return null;

  const membership = await findMembership(userId, service.businessId);
  if (
    !membership ||
    (membership.role !== "OWNER" && membership.role !== "ADMIN")
  ) {
    return null;
  }

  const updated = await prisma.service.update({
    where: { id: serviceId },
    data: data as Parameters<typeof prisma.service.update>[0]["data"],
  });

  return { ...updated as ServiceDto, role: membership.role };
}

/** Soft-ish delete via active flag if the caller is an OWNER or ADMIN. */
export async function archiveServiceForUser(
  userId: string,
  serviceId: string,
): Promise<ServiceWithRole | null> {
  const service = await prisma.service.findUnique({ where: { id: serviceId } });
  if (!service) return null;

  const membership = await findMembership(userId, service.businessId);
  if (
    !membership ||
    (membership.role !== "OWNER" && membership.role !== "ADMIN")
  ) {
    return null;
  }

  const updated = await prisma.service.update({
    where: { id: serviceId },
    data: { active: false },
  });

  return { ...updated as ServiceDto, role: membership.role };
}

/**
 * Public embed lookup — attach a visitor's picked service to their lead
 * (FEATURES §21–22, §17). The businessId is the server-resolved ref of an
 * ACTIVE business, never a client-supplied identity (§7, §52); an id from
 * any other tenant — or an archived service — returns null so it is ignored
 * instead of linked (§13).
 */
export async function findPublicActiveService(
  businessId: string,
  serviceId: string,
): Promise<{ id: string } | null> {
  return prisma.service.findFirst({
    where: { id: serviceId, businessId, active: true },
    select: { id: true },
  });
}
