import type {
  CreateLeadInput,
  LeadDto,
  ListLeadsQuery,
  UpdateLeadInput,
} from "../validation/lead.schemas";
import { prisma } from "../lib/prisma";
import { recordAnalyticsEvent } from "./analytics-events.repository";
import { findMembership } from "./membership.repository";
import { canTransitionLead, type LeadStatus } from "../services/lead-status";

/** Lead with relations the detail view and list rows need (§29–30). */
export interface LeadWithRelations extends LeadDto {
  customer: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
  };
  service: { id: string; name: string } | null;
}

/** A lead plus the caller's role for API responses. */
export interface LeadWithRole extends LeadWithRelations {
  role: "OWNER" | "ADMIN" | "STAFF";
}

export interface LeadPage {
  leads: LeadWithRelations[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Tenant-scoped lead access (FEATURES §15, agent.md §13, §19).
 * Every function verifies membership with the authenticated userId before
 * touching the row, so a businessId never comes from the client.
 */

/** Filters a list query can carry; businessId may also be an id set. */
interface LeadWhereInput extends Omit<Partial<ListLeadsQuery>, "businessId"> {
  businessId: string | { in: string[] };
}

/** Build the tenant-scoped Prisma where clause for a list query. */
function leadWhere(query: LeadWhereInput) {
  const where: Record<string, unknown> = { businessId: query.businessId };

  if (query.status) where.status = query.status;
  if (query.urgency) where.urgency = query.urgency;
  if (query.source) where.source = query.source;
  if (query.serviceId) where.serviceId = query.serviceId;
  if (query.customerId) where.customerId = query.customerId;

  if (query.from || query.to) {
    where.createdAt = {
      ...(query.from ? { gte: query.from } : {}),
      ...(query.to ? { lte: query.to } : {}),
    };
  }

  if (query.minScore !== undefined || query.maxScore !== undefined) {
    where.leadScore = {
      ...(query.minScore !== undefined ? { gte: query.minScore } : {}),
      ...(query.maxScore !== undefined ? { lte: query.maxScore } : {}),
    };
  }

  if (query.search) {
    // Search across the customer's contact details and the enquiry message.
    where.OR = [
      { customer: { name: { contains: query.search, mode: "insensitive" } } },
      { customer: { phone: { contains: query.search, mode: "insensitive" } } },
      { customer: { email: { contains: query.search, mode: "insensitive" } } },
      { postcode: { contains: query.search, mode: "insensitive" } },
      { location: { contains: query.search, mode: "insensitive" } },
      { customerMessage: { contains: query.search, mode: "insensitive" } },
    ];
  }

  return where;
}

/** A lead row as stored — the fields relation lookup needs. */
type LeadRow = LeadDto & { id: string };

/** Attach customer + service to a lead row for the API. */
async function withRelations<T extends LeadRow>(
  leads: T[],
): Promise<LeadWithRelations[]> {
  if (leads.length === 0) return [];

  const [customers, services] = await Promise.all([
    prisma.customer.findMany({
      where: { id: { in: leads.map((l) => l.customerId) } },
      select: { id: true, name: true, phone: true, email: true },
    }),
    prisma.service.findMany({
      where: { id: { in: leads.map((l) => l.serviceId).filter(Boolean) as string[] } },
      select: { id: true, name: true },
    }),
  ]);

  const customerById = new Map(customers.map((c) => [c.id, c]));
  const serviceById = new Map(services.map((s) => [s.id, s]));

  return (leads as LeadRow[]).map((lead) => ({
    ...lead,
    customer: customerById.get(lead.customerId) ?? {
      id: lead.customerId,
      name: "Unknown customer",
      phone: null,
      email: null,
    },
    service: lead.serviceId ? (serviceById.get(lead.serviceId) ?? null) : null,
  })) as LeadWithRelations[];
}

/**
 * List leads for one business the caller belongs to, with filters,
 * pagination and a total count (§29). Returns null when the caller is not
 * a member so the controller can answer 404.
 */
export async function listLeadsForBusiness(
  userId: string,
  query: ListLeadsQuery,
  businessId: string,
): Promise<LeadPage | null> {
  const membership = await findMembership(userId, businessId);
  if (!membership) return null;

  const where = leadWhere({ ...query, businessId });
  const skip = (query.page - 1) * query.pageSize;

  const [rows, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: query.pageSize,
    }),
    prisma.lead.count({ where }),
  ]);

  return {
    leads: await withRelations(rows),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** List leads across all the caller's businesses (most recent first). */
export async function listLeadsForUser(
  userId: string,
  query: Omit<ListLeadsQuery, "businessId">,
): Promise<LeadWithRelations[]> {
  const memberships = await prisma.businessMember.findMany({
    where: { userId },
    select: { businessId: true },
  });
  if (memberships.length === 0) return [];

  const where = leadWhere({
    ...query,
    businessId: { in: memberships.map((m) => m.businessId) },
  });

  const rows = await prisma.lead.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: query.pageSize,
  });

  return withRelations(rows);
}

/** Read one lead (with relations) if the caller is a member of its business. */
export async function findLeadForUser(
  userId: string,
  leadId: string,
): Promise<LeadWithRole | null> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return null;

  const membership = await findMembership(userId, lead.businessId);
  if (!membership) return null;

  const [withRel] = await withRelations([lead]);
  if (!withRel) return null;
  return { ...withRel, role: membership.role };
}

/** Create a lead for a business the caller belongs to (any member role). */
export async function createLeadForUser(
  userId: string,
  input: CreateLeadInput,
): Promise<LeadWithRole | null> {
  const membership = await findMembership(userId, input.businessId);
  if (!membership) return null;

  // The customer must belong to the same business (§13) — a lead never
  // crosses tenants.
  const customer = await prisma.customer.findFirst({
    where: { id: input.customerId, businessId: input.businessId },
    select: { id: true },
  });
  if (!customer) return null;

  // The service, when named, must also belong to this business.
  if (input.serviceId) {
    const service = await prisma.service.findFirst({
      where: { id: input.serviceId, businessId: input.businessId },
      select: { id: true },
    });
    if (!service) return null;
  }

  const lead = await prisma.lead.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId,
      serviceId: input.serviceId ?? null,
      source: input.source,
      urgency: input.urgency ?? null,
      location: input.location ?? null,
      postcode: input.postcode ?? null,
      budget: input.budget ?? null,
      preferredDate: input.preferredDate ?? null,
      preferredTime: input.preferredTime ?? null,
      customerMessage: input.customerMessage ?? null,
    },
  });

  const [withRel] = await withRelations([lead]);
  return withRel ? { ...withRel, role: membership.role } : null;
}

/** Update a lead's qualification fields (any member role). */
export async function updateLeadForUser(
  userId: string,
  leadId: string,
  data: UpdateLeadInput,
): Promise<LeadWithRole | null> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return null;

  const membership = await findMembership(userId, lead.businessId);
  if (!membership) return null;

  // A reassigned service must belong to the same business (§13).
  if (data.serviceId) {
    const service = await prisma.service.findFirst({
      where: { id: data.serviceId, businessId: lead.businessId },
      select: { id: true },
    });
    if (!service) return null;
  }

  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: {
      ...(data.serviceId !== undefined ? { serviceId: data.serviceId } : {}),
      ...(data.urgency !== undefined ? { urgency: data.urgency } : {}),
      ...(data.location !== undefined ? { location: data.location } : {}),
      ...(data.postcode !== undefined ? { postcode: data.postcode } : {}),
      ...(data.budget !== undefined ? { budget: data.budget } : {}),
      ...(data.preferredDate !== undefined
        ? { preferredDate: data.preferredDate }
        : {}),
      ...(data.preferredTime !== undefined
        ? { preferredTime: data.preferredTime }
        : {}),
      ...(data.customerMessage !== undefined
        ? { customerMessage: data.customerMessage }
        : {}),
    },
  });

  const [withRel] = await withRelations([updated]);
  return withRel ? { ...withRel, role: membership.role } : null;
}

/** Outcome of a status change: the updated lead or the rejection reason. */
export type StatusChangeResult =
  | { ok: true; lead: LeadWithRole }
  | { ok: false; reason: "not_found" | "invalid_transition" };

/**
 * Change a lead's status — the ONLY way status ever changes (agent.md §19).
 * Invalid jumps are rejected with the backend-owned transition table.
 */
export async function changeLeadStatusForUser(
  userId: string,
  leadId: string,
  to: LeadStatus,
): Promise<StatusChangeResult> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { ok: false, reason: "not_found" };

  const membership = await findMembership(userId, lead.businessId);
  if (!membership) return { ok: false, reason: "not_found" };

  if (!canTransitionLead(lead.status as LeadStatus, to)) {
    return { ok: false, reason: "invalid_transition" };
  }

  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: { status: to },
  });

  // Platform analytics records every status move (FEATURES §51); the guard
  // above already made this the only path, so events cannot double-fire.
  // Leads are always moved by staff: the AI tools deliberately cannot change
  // a lead's status (agent.md §19). Awaited but non-throwing — see
  // recordAnalyticsEvent (§8: analytics failures never break the flow).
  await recordAnalyticsEvent({
    type: "LEAD_STATUS_CHANGED",
    businessId: lead.businessId,
    leadId: lead.id,
    fromStatus: lead.status,
    toStatus: to,
    initiator: "STAFF",
  });

  const [withRel] = await withRelations([updated]);
  if (!withRel) return { ok: false, reason: "not_found" };
  return { ok: true, lead: { ...withRel, role: membership.role } };
}
