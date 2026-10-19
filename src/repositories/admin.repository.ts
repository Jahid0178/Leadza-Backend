import { prisma } from "../lib/prisma";
import { recordAudit, type AuditAction } from "../services/audit.service";
import type {
  AdminAuditEntryDto,
  AdminBusinessDetailDto,
  AdminBusinessOwnerDto,
  AdminBusinessSummaryDto,
  AdminOverviewDto,
  AdminSubscriptionDto,
  AdminSubscriptionPageDto,
  AdminSubscriptionSummaryDto,
  AdminUserDetailDto,
  AdminUserSummaryDto,
  BusinessStatusInput,
  ListAdminBusinessesQuery,
  ListAdminSubscriptionsQuery,
  ListAdminUsersQuery,
  ListAuditLogsQuery,
  MemberRoleDto,
  PlatformRoleInput,
  UserStatusInput,
} from "../validation/admin.schemas";

/**
 * Platform-wide data access for the admin area (FEATURES §40–43, §45;
 * IMPLEMENTATION_PLAN steps 28–29).
 *
 * **This is the one deliberate exception to the tenant-scoping rule** (§7,
 * §13): a platform administrator operates every business, so these queries are
 * intentionally unscoped by `businessId`. Two things keep that safe:
 *   - every route in front of them is gated by `requirePlatformAdmin`
 *     (routes/admin.routes.ts), which re-checks the role against the database;
 *   - nothing here is reachable from the AI agent, the widget, or any
 *     business-scoped controller.
 * Business-facing repositories keep their membership-embedded WHERE clauses —
 * `findMembership` refuses a suspended business there (§42–43).
 */

/** Who performed an audited action — the verified session user. */
export interface AdminActor {
  id: string;
  email: string;
}

/* ------------------------------------------------------------------ *
 * Business
 * ------------------------------------------------------------------ */

const ROLE_RANK: Record<MemberRoleDto, number> = { OWNER: 0, ADMIN: 1, STAFF: 2 };

type MemberRow = {
  role: MemberRoleDto;
  user: { id: string; email: string; name: string | null };
};

/** Members with owners first, then admins, then staff (stable per role). */
function toMemberDtos(members: MemberRow[]): AdminBusinessOwnerDto[] {
  return [...members]
    .sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role])
    .map((member) => ({
      id: member.user.id,
      email: member.user.email,
      name: member.user.name,
      role: member.role,
    }));
}

/** Columns every business row needs — never the whole record by accident. */
const businessSummarySelect = {
  id: true,
  name: true,
  type: true,
  phone: true,
  email: true,
  address: true,
  website: true,
  description: true,
  status: true,
  timezone: true,
  currency: true,
  createdAt: true,
  onboardingCompletedAt: true,
  members: {
    select: {
      role: true,
      user: { select: { id: true, email: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
  },
  _count: {
    select: {
      members: true,
      customers: true,
      leads: true,
      conversations: true,
      bookings: true,
    },
  },
} as const;

/** The shape `businessSummarySelect` returns. */
interface BusinessSummaryRow {
  id: string;
  name: string;
  type: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  website: string | null;
  description: string | null;
  status: BusinessStatusInput;
  timezone: string;
  currency: string;
  createdAt: Date;
  onboardingCompletedAt: Date | null;
  members: MemberRow[];
  _count: {
    members: number;
    customers: number;
    leads: number;
    conversations: number;
    bookings: number;
  };
}

function toBusinessSummary(row: BusinessSummaryRow): AdminBusinessSummaryDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    phone: row.phone,
    email: row.email,
    status: row.status,
    timezone: row.timezone,
    currency: row.currency,
    createdAt: row.createdAt,
    onboardingCompletedAt: row.onboardingCompletedAt,
    counts: {
      members: row._count.members,
      customers: row._count.customers,
      leads: row._count.leads,
      conversations: row._count.conversations,
      bookings: row._count.bookings,
    },
    // §42 "view business owners" — the people to contact about this tenant.
    owners: toMemberDtos(row.members.filter((member) => member.role === "OWNER")),
  };
}

/** Build the admin business WHERE clause (search + status filter). */
function businessWhere(query: ListAdminBusinessesQuery): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (query.status) where.status = query.status;
  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: "insensitive" } },
      { email: { contains: query.search, mode: "insensitive" } },
      { phone: { contains: query.search, mode: "insensitive" } },
    ];
  }
  return where;
}

/** §42 /admin/businesses — every business on the platform, searchable. */
export async function listBusinessesForAdmin(
  query: ListAdminBusinessesQuery,
): Promise<{
  businesses: AdminBusinessSummaryDto[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const where = businessWhere(query);

  const [rows, total] = await Promise.all([
    prisma.business.findMany({
      where,
      select: businessSummarySelect,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.business.count({ where }),
  ]);

  return {
    businesses: rows.map(toBusinessSummary),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** §42 business detail: profile, members and the tenant's recent audit trail. */
export async function findBusinessForAdmin(
  businessId: string,
): Promise<AdminBusinessDetailDto | null> {
  const row = await prisma.business.findUnique({
    where: { id: businessId },
    select: businessSummarySelect,
  });
  if (!row) return null;

  const recentAudit = await prisma.auditLog.findMany({
    where: { businessId },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  return {
    ...toBusinessSummary(row),
    address: row.address,
    website: row.website,
    description: row.description,
    members: toMemberDtos(row.members),
    recentAudit: recentAudit.map(toAuditDto),
  };
}

export type SetBusinessStatusResult =
  | {
      ok: true;
      /** false when the business already had that status (nothing was logged). */
      changed: boolean;
      previousStatus: BusinessStatusInput;
      business: AdminBusinessDetailDto;
    }
  | { ok: false; reason: "not_found" };

/**
 * §42 suspend/restore. The status change and its audit entry are written in
 * one transaction, so an unaudited suspension is impossible.
 */
export async function setBusinessStatusForAdmin(
  businessId: string,
  status: BusinessStatusInput,
  actor: AdminActor,
): Promise<SetBusinessStatusResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const existing = await tx.business.findUnique({
      where: { id: businessId },
      select: { id: true, status: true },
    });
    if (!existing) return null;

    // PATCH stays idempotent: re-sending the current status is a no-op and
    // does not pollute the audit trail.
    if (existing.status === status) {
      return { changed: false, previousStatus: existing.status };
    }

    await tx.business.update({ where: { id: businessId }, data: { status } });
    await recordAudit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        action: actionForBusinessStatus(status),
        resourceType: "business",
        resourceId: businessId,
        businessId,
        metadata: { from: existing.status, to: status },
      },
      tx,
    );

    return { changed: true, previousStatus: existing.status };
  });

  if (!outcome) return { ok: false, reason: "not_found" };

  const business = await findBusinessForAdmin(businessId);
  if (!business) return { ok: false, reason: "not_found" };

  return {
    ok: true,
    changed: outcome.changed,
    previousStatus: outcome.previousStatus,
    business,
  };
}

function actionForBusinessStatus(status: BusinessStatusInput): AuditAction {
  return status === "SUSPENDED" ? "business.suspended" : "business.restored";
}

/* ------------------------------------------------------------------ *
 * User
 * ------------------------------------------------------------------ */

/** Explicit selection — `passwordHash` is never part of an admin response. */
const userSelect = {
  id: true,
  email: true,
  name: true,
  platformRole: true,
  status: true,
  emailVerified: true,
  createdAt: true,
  memberships: {
    select: {
      role: true,
      business: { select: { id: true, name: true, status: true } },
    },
    orderBy: { createdAt: "asc" },
  },
  _count: { select: { createdBookings: true, assignedConversations: true } },
} as const;

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  platformRole: PlatformRoleInput;
  status: UserStatusInput;
  emailVerified: Date | null;
  createdAt: Date;
  memberships: Array<{
    role: MemberRoleDto;
    business: { id: string; name: string; status: BusinessStatusInput };
  }>;
  _count: { createdBookings: number; assignedConversations: number };
}

function toUserSummary(row: UserRow): AdminUserSummaryDto {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    platformRole: row.platformRole,
    status: row.status,
    emailVerified: row.emailVerified,
    createdAt: row.createdAt,
    memberships: row.memberships.map((membership) => ({
      businessId: membership.business.id,
      businessName: membership.business.name,
      businessStatus: membership.business.status,
      role: membership.role,
    })),
  };
}

function toUserDetail(row: UserRow): AdminUserDetailDto {
  return {
    ...toUserSummary(row),
    counts: {
      createdBookings: row._count.createdBookings,
      assignedConversations: row._count.assignedConversations,
    },
  };
}

/** §43 /admin/users — every account, searchable by email/name/role/status. */
export async function listUsersForAdmin(query: ListAdminUsersQuery): Promise<{
  users: AdminUserSummaryDto[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const where: Record<string, unknown> = {};
  if (query.status) where.status = query.status;
  if (query.role) where.platformRole = query.role;
  if (query.businessId) where.memberships = { some: { businessId: query.businessId } };
  if (query.search) {
    where.OR = [
      { email: { contains: query.search, mode: "insensitive" } },
      { name: { contains: query.search, mode: "insensitive" } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: userSelect,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.user.count({ where }),
  ]);

  return {
    users: rows.map(toUserSummary),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** §43 user detail: account, memberships, activity counts. */
export async function findUserForAdmin(userId: string): Promise<AdminUserDetailDto | null> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: userSelect });
  return row ? toUserDetail(row) : null;
}

/** How many active platform administrators exist (§43 lockout protection). */
export async function countActivePlatformAdmins(): Promise<number> {
  return prisma.user.count({
    where: { platformRole: "PLATFORM_ADMIN", status: "ACTIVE" },
  });
}

export type SetUserResult =
  | {
      ok: true;
      changed: boolean;
      previousStatus: UserStatusInput;
      user: AdminUserDetailDto;
    }
  | { ok: false; reason: "not_found" };

/** §43 suspend/restore a user account (blocks sign-in at the next login). */
export async function setUserStatusForAdmin(
  userId: string,
  status: UserStatusInput,
  actor: AdminActor,
): Promise<SetUserResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true },
    });
    if (!existing) return null;
    if (existing.status === status) {
      return { changed: false, previousStatus: existing.status };
    }

    await tx.user.update({ where: { id: userId }, data: { status } });
    await recordAudit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        action: status === "SUSPENDED" ? "user.suspended" : "user.restored",
        resourceType: "user",
        resourceId: userId,
        metadata: { from: existing.status, to: status },
      },
      tx,
    );

    return { changed: true, previousStatus: existing.status };
  });

  if (!outcome) return { ok: false, reason: "not_found" };

  const user = await findUserForAdmin(userId);
  if (!user) return { ok: false, reason: "not_found" };

  return {
    ok: true,
    changed: outcome.changed,
    previousStatus: outcome.previousStatus,
    user,
  };
}

export type SetPlatformRoleResult =
  | {
      ok: true;
      changed: boolean;
      previousRole: PlatformRoleInput;
      user: AdminUserDetailDto;
    }
  | { ok: false; reason: "not_found" };

/** §43 change a platform-level role, audited like every other sensitive action. */
export async function setPlatformRoleForAdmin(
  userId: string,
  platformRole: PlatformRoleInput,
  actor: AdminActor,
): Promise<SetPlatformRoleResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, platformRole: true },
    });
    if (!existing) return null;
    if (existing.platformRole === platformRole) {
      return { changed: false, previousRole: existing.platformRole };
    }

    await tx.user.update({ where: { id: userId }, data: { platformRole } });
    await recordAudit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        action: "user.platform_role_changed",
        resourceType: "user",
        resourceId: userId,
        metadata: { from: existing.platformRole, to: platformRole },
      },
      tx,
    );

    return { changed: true, previousRole: existing.platformRole };
  });

  if (!outcome) return { ok: false, reason: "not_found" };

  const user = await findUserForAdmin(userId);
  if (!user) return { ok: false, reason: "not_found" };

  return {
    ok: true,
    changed: outcome.changed,
    previousRole: outcome.previousRole,
    user,
  };
}

/* ------------------------------------------------------------------ *
 * Overview + audit trail
 * ------------------------------------------------------------------ */

function toAuditDto(row: {
  id: string;
  actorId: string;
  actorEmail: string;
  action: string;
  resourceType: string;
  resourceId: string;
  businessId: string | null;
  metadata: unknown;
  createdAt: Date;
}): AdminAuditEntryDto {
  return {
    id: row.id,
    actorId: row.actorId,
    actorEmail: row.actorEmail,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    businessId: row.businessId,
    metadata: (row.metadata ?? null) as Record<string, unknown> | null,
    createdAt: row.createdAt,
  };
}

/** Midnight UTC today — "leads today" is counted on the platform clock. */
function startOfUtcToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * §41 platform-wide statistics. AI usage, estimated cost and MRR stay null
 * until Phase H (steps 30–32) adds metering and billing — the UI shows them as
 * unavailable rather than as a misleading zero.
 */
export async function getPlatformOverview(): Promise<AdminOverviewDto> {
  const since = startOfUtcToday();

  const [
    totalBusinesses,
    activeBusinesses,
    totalUsers,
    suspendedUsers,
    platformAdmins,
    leadsToday,
    qualifiedLeads,
    bookings,
    aiConversations,
  ] = await Promise.all([
    prisma.business.count(),
    prisma.business.count({ where: { status: "ACTIVE" } }),
    prisma.user.count(),
    prisma.user.count({ where: { status: "SUSPENDED" } }),
    prisma.user.count({ where: { platformRole: "PLATFORM_ADMIN" } }),
    prisma.lead.count({ where: { createdAt: { gte: since } } }),
    // Cumulative funnel (matches §28): reached QUALIFIED or beyond.
    prisma.lead.count({ where: { status: { in: ["QUALIFIED", "BOOKED", "WON"] } } }),
    prisma.booking.count(),
    prisma.conversation.count({ where: { messages: { some: { sender: "AI" } } } }),
  ]);

  return {
    businesses: {
      total: totalBusinesses,
      active: activeBusinesses,
      suspended: totalBusinesses - activeBusinesses,
    },
    users: { total: totalUsers, suspended: suspendedUsers, platformAdmins },
    leadsToday,
    qualifiedLeads,
    bookings,
    aiConversations,
    aiUsage: null,
    estimatedAiCost: null,
    mrr: null,
  };
}

/** §45 /admin/audit-logs — read-only, newest first. */
export async function listAuditLogsForAdmin(query: ListAuditLogsQuery): Promise<{
  logs: AdminAuditEntryDto[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const where: Record<string, unknown> = {};
  if (query.action) where.action = query.action;
  if (query.resourceType) where.resourceType = query.resourceType;
  if (query.resourceId) where.resourceId = query.resourceId;
  if (query.businessId) where.businessId = query.businessId;
  if (query.actorId) where.actorId = query.actorId;

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return {
    logs: rows.map(toAuditDto),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/* ------------------------------------------------------------------ *
 * Billing (Phase H) — every mirrored Paddle subscription
 * ------------------------------------------------------------------ */

/** Columns the admin billing table needs — never the whole record. */
const subscriptionAdminSelect = {
  subscriptionId: true,
  status: true,
  priceId: true,
  productId: true,
  scheduledChangeAction: true,
  scheduledChangeAt: true,
  paddleCreatedAt: true,
  nextBilledAt: true,
  createdAt: true,
  updatedAt: true,
  business: { select: { id: true, name: true, status: true } },
  customer: { select: { customerId: true, email: true } },
} as const;

interface SubscriptionAdminRow {
  subscriptionId: string;
  status: string;
  priceId: string;
  productId: string;
  scheduledChangeAction: string | null;
  scheduledChangeAt: Date | null;
  paddleCreatedAt: Date | null;
  nextBilledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  business: { id: string; name: string; status: BusinessStatusInput } | null;
  customer: { customerId: string; email: string };
}

function toSubscriptionAdminDto(
  row: SubscriptionAdminRow,
): AdminSubscriptionDto {
  return {
    subscriptionId: row.subscriptionId,
    status: row.status,
    priceId: row.priceId,
    productId: row.productId,
    scheduledChangeAction: row.scheduledChangeAction,
    scheduledChangeAt: row.scheduledChangeAt,
    paddleCreatedAt: row.paddleCreatedAt,
    nextBilledAt: row.nextBilledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    business: row.business,
    customer: row.customer,
  };
}

function toSubscriptionSummary(
  groups: Array<{ status: string; _count: { _all: number } }>,
): AdminSubscriptionSummaryDto {
  const summary: AdminSubscriptionSummaryDto = {
    total: 0,
    active: 0,
    trialing: 0,
    pastDue: 0,
    paused: 0,
    canceled: 0,
  };

  for (const group of groups) {
    const count = group._count._all;
    summary.total += count;
    // Statuses we do not know yet still count toward the total, but never get
    // folded into a named bucket.
    if (group.status === "past_due") summary.pastDue += count;
    else if (
      group.status === "active" ||
      group.status === "trialing" ||
      group.status === "paused" ||
      group.status === "canceled"
    ) {
      summary[group.status] += count;
    }
  }

  return summary;
}

/**
 * Billing list for the platform admin (Phase H).
 *
 * Cross-tenant by design, like the rest of this file: it is gated by
 * `requirePlatformAdmin` and never reachable from a business-scoped route.
 * The summary is computed over **every** subscription, not the filtered page,
 * so the tiles stay stable while the operator filters the table.
 */
export async function listSubscriptionsForAdmin(
  query: ListAdminSubscriptionsQuery,
): Promise<AdminSubscriptionPageDto> {
  const where: Record<string, unknown> = {};
  if (query.status) where.status = query.status;
  if (query.search) {
    where.OR = [
      { business: { name: { contains: query.search, mode: "insensitive" } } },
      { customer: { email: { contains: query.search, mode: "insensitive" } } },
      { subscriptionId: { contains: query.search, mode: "insensitive" } },
    ];
  }

  const [rows, total, groups] = await Promise.all([
    prisma.subscription.findMany({
      where,
      select: subscriptionAdminSelect,
      orderBy: { updatedAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.subscription.count({ where }),
    prisma.subscription.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  return {
    subscriptions: rows.map(toSubscriptionAdminDto),
    total,
    page: query.page,
    pageSize: query.pageSize,
    summary: toSubscriptionSummary(groups),
  };
}
