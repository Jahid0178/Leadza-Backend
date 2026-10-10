import type {
  KnowledgeDto,
  CreateKnowledgeInput,
  UpdateKnowledgeInput,
} from "../validation/knowledge.schemas";
import { prisma } from "../lib/prisma";
import { findMembership } from "./membership.repository";

/** A knowledge entry plus the caller's role for API responses. */
export interface KnowledgeWithRole extends KnowledgeDto {
  role: "OWNER" | "ADMIN" | "STAFF";
}

/**
 * Tenant-scoped knowledge access (FEATURES §13, agent.md §13).
 * Knowledge scope is the current business only, so entries are never shared
 * across businesses and the AI context builder can load them safely.
 *
 * Listing returns every entry that is not archived — including drafts
 * (isActive: false), which the dashboard needs to show. Anything that feeds
 * the AI must additionally filter on `isActive: true`.
 */

/** List knowledge entries across all the caller's businesses. */
export async function listKnowledgeForUser(
  userId: string,
): Promise<KnowledgeWithRole[]> {
  const memberships = await prisma.businessMember.findMany({
    where: { userId },
    include: {
      business: {
        include: {
          knowledge: {
            where: { archivedAt: null },
            orderBy: { category: "asc" },
          },
        },
      },
    },
  });

  const rows: KnowledgeWithRole[] = [];
  for (const membership of memberships) {
    for (const entry of membership.business.knowledge) {
      rows.push({ ...entry as KnowledgeDto, role: membership.role });
    }
  }

  return rows.sort((a, b) =>
    a.businessId.localeCompare(b.businessId) || a.category.localeCompare(b.category),
  );
}

/** List knowledge for one business the caller belongs to. */
export async function listKnowledgeForBusiness(
  userId: string,
  businessId: string,
): Promise<KnowledgeWithRole[]> {
  const membership = await findMembership(userId, businessId);
  if (!membership) return [];

  const entries = await prisma.knowledgeEntry.findMany({
    where: { businessId, archivedAt: null },
    orderBy: { category: "asc" },
  });

  return entries.map((entry) => ({
    ...entry as KnowledgeDto,
    role: membership.role,
  }));
}

/** Read one knowledge entry if the caller is a member of its business. */
export async function findKnowledgeForUser(
  userId: string,
  entryId: string,
): Promise<KnowledgeWithRole | null> {
  const entry = await prisma.knowledgeEntry.findUnique({ where: { id: entryId } });
  if (!entry) return null;

  const membership = await findMembership(userId, entry.businessId);
  if (!membership) return null;

  return { ...entry as KnowledgeDto, role: membership.role };
}

/** Create a knowledge entry for a business the caller owns or admins. */
export async function createKnowledgeForUser(
  userId: string,
  businessId: string,
  data: CreateKnowledgeInput,
): Promise<KnowledgeWithRole | null> {
  const membership = await findMembership(userId, businessId);
  if (!membership || !["OWNER", "ADMIN"].includes(membership.role)) {
    return null;
  }

  const entry = await prisma.knowledgeEntry.create({
    data: { ...data, businessId },
  });

  return { ...entry as KnowledgeDto, role: membership.role };
}

/** Update a knowledge entry if the caller is an OWNER or ADMIN. */
export async function updateKnowledgeForUser(
  userId: string,
  entryId: string,
  data: UpdateKnowledgeInput,
): Promise<KnowledgeWithRole | null> {
  const entry = await prisma.knowledgeEntry.findUnique({ where: { id: entryId } });
  if (!entry) return null;

  const membership = await findMembership(userId, entry.businessId);
  if (
    !membership ||
    (membership.role !== "OWNER" && membership.role !== "ADMIN")
  ) {
    return null;
  }

  const updated = await prisma.knowledgeEntry.update({
    where: { id: entryId },
    data: data as Parameters<typeof prisma.knowledgeEntry.update>[0]["data"],
  });

  return { ...updated as KnowledgeDto, role: membership.role };
}

/**
 * Archives an entry: it leaves the dashboard list (and, once built, the AI's
 * context) but the row is kept so it can be restored later. Archiving is
 * deliberately separate from the draft flag — a draft (isActive: false) is
 * still an editable, listed entry.
 */
export async function archiveKnowledgeForUser(
  userId: string,
  entryId: string,
): Promise<KnowledgeWithRole | null> {
  const entry = await prisma.knowledgeEntry.findUnique({ where: { id: entryId } });
  if (!entry) return null;

  const membership = await findMembership(userId, entry.businessId);
  if (
    !membership ||
    (membership.role !== "OWNER" && membership.role !== "ADMIN")
  ) {
    return null;
  }

  const updated = await prisma.knowledgeEntry.update({
    where: { id: entryId },
    data: { archivedAt: new Date() },
  });

  return { ...updated as KnowledgeDto, role: membership.role };
}
