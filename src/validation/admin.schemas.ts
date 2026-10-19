import { z } from "zod";
import { AUDIT_ACTIONS, AUDIT_RESOURCE_TYPES } from "../services/audit.service";

/**
 * Validation + response shapes for the platform admin area
 * (FEATURES §40–43, §45; IMPLEMENTATION_PLAN steps 28–29).
 *
 * Admin queries are cross-tenant by design (a platform administrator operates
 * the whole platform, §5) — the tenant scope is deliberately absent here,
 * unlike every business-scoped schema.
 */

export const businessStatusSchema = z.enum(["ACTIVE", "SUSPENDED"]);
export type BusinessStatusInput = z.infer<typeof businessStatusSchema>;

export const userStatusSchema = z.enum(["ACTIVE", "SUSPENDED"]);
export type UserStatusInput = z.infer<typeof userStatusSchema>;

export const platformRoleSchema = z.enum(["USER", "PLATFORM_ADMIN"]);
export type PlatformRoleInput = z.infer<typeof platformRoleSchema>;

export const memberRoleSchema = z.enum(["OWNER", "ADMIN", "STAFF"]);
export type MemberRoleDto = z.infer<typeof memberRoleSchema>;

/** PATCH /api/v1/admin/businesses/:businessId/status */
export const changeBusinessStatusSchema = z
  .object({ status: businessStatusSchema })
  .strict();

/** PATCH /api/v1/admin/users/:userId/status */
export const changeUserStatusSchema = z.object({ status: userStatusSchema }).strict();

/** PATCH /api/v1/admin/users/:userId/platform-role */
export const changePlatformRoleSchema = z
  .object({ platformRole: platformRoleSchema })
  .strict();

/** GET /api/v1/admin/businesses — §42 search. */
export const listAdminBusinessesQuerySchema = z.object({
  /** Free-text search over name/email/phone. */
  search: z.string().trim().max(200).optional(),
  status: businessStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListAdminBusinessesQuery = z.infer<typeof listAdminBusinessesQuerySchema>;

/** GET /api/v1/admin/users — §43 search. */
export const listAdminUsersQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: userStatusSchema.optional(),
  role: platformRoleSchema.optional(),
  /** Only users who belong to this business. */
  businessId: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListAdminUsersQuery = z.infer<typeof listAdminUsersQuerySchema>;

/** GET /api/v1/admin/audit-logs — §45 read-only trail. */
export const listAuditLogsQuerySchema = z.object({
  action: z.enum(AUDIT_ACTIONS).optional(),
  resourceType: z.enum(AUDIT_RESOURCE_TYPES).optional(),
  resourceId: z.string().trim().min(1).optional(),
  businessId: z.string().trim().min(1).optional(),
  actorId: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;

/**
 * Paddle subscription statuses we mirror. Kept in sync with
 * `server/src/services/paddle-billing.ts` — `active`/`trialing` grant product
 * access, the rest deny it.
 */
export const subscriptionStatusSchema = z.enum([
  "active",
  "trialing",
  "past_due",
  "paused",
  "canceled",
]);

/** GET /api/v1/admin/subscriptions — cross-tenant billing list. */
export const listAdminSubscriptionsQuerySchema = z.object({
  /** Matches business name, customer email or the Paddle subscription id. */
  search: z.string().trim().max(200).optional(),
  status: subscriptionStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListAdminSubscriptionsQuery = z.infer<
  typeof listAdminSubscriptionsQuerySchema
>;

/* ------------------------------------------------------------------ *
 * Response shapes (agent.md §26) — never include passwordHash or any
 * field the admin UI does not need.
 * ------------------------------------------------------------------ */

/** §41 platform-wide statistics. */
export interface AdminOverviewDto {
  businesses: { total: number; active: number; suspended: number };
  users: { total: number; suspended: number; platformAdmins: number };
  /** Leads created since midnight UTC today. */
  leadsToday: number;
  /** Leads that reached QUALIFIED or beyond (funnel semantics, §28). */
  qualifiedLeads: number;
  bookings: number;
  /** Conversations the AI has actually replied in (§41 "AI conversations"). */
  aiConversations: number;
  /** Phase H, steps 30–32 — nothing meters these yet. */
  aiUsage: null;
  estimatedAiCost: null;
  mrr: null;
}

export interface AdminBusinessOwnerDto {
  id: string;
  email: string;
  name: string | null;
  role: MemberRoleDto;
}

/** §42 business row. */
export interface AdminBusinessSummaryDto {
  id: string;
  name: string;
  type: string | null;
  phone: string | null;
  email: string | null;
  status: BusinessStatusInput;
  timezone: string;
  currency: string;
  createdAt: Date;
  onboardingCompletedAt: Date | null;
  counts: {
    members: number;
    customers: number;
    leads: number;
    conversations: number;
    bookings: number;
  };
  /** Owners first, then admins/staff — who to contact about this tenant. */
  owners: AdminBusinessOwnerDto[];
}

/** §42 business detail: the row plus every membership and recent audit. */
export interface AdminBusinessDetailDto extends AdminBusinessSummaryDto {
  address: string | null;
  website: string | null;
  description: string | null;
  members: AdminBusinessOwnerDto[];
  recentAudit: AdminAuditEntryDto[];
}

/** §43 user row: the account plus where it belongs. */
export interface AdminUserSummaryDto {
  id: string;
  email: string;
  name: string | null;
  platformRole: PlatformRoleInput;
  status: UserStatusInput;
  emailVerified: Date | null;
  createdAt: Date;
  memberships: Array<{
    businessId: string;
    businessName: string;
    businessStatus: BusinessStatusInput;
    role: MemberRoleDto;
  }>;
}

/** §43 user detail: the row plus lead/booking activity counts. */
export interface AdminUserDetailDto extends AdminUserSummaryDto {
  counts: { createdBookings: number; assignedConversations: number };
}

/** §45 audit entry as the read-only table shows it. */
export interface AdminAuditEntryDto {
  id: string;
  actorId: string;
  actorEmail: string;
  action: string;
  resourceType: string;
  resourceId: string;
  businessId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

/** Tenant a subscription belongs to; null until the link is resolved. */
export interface AdminSubscriptionBusinessDto {
  id: string;
  name: string;
  status: BusinessStatusInput;
}

/**
 * One mirrored Paddle subscription. Plan naming lives in the frontend
 * (`client/content/pricing.ts`), so the API reports the price/product ids it
 * actually stored rather than inventing a label here.
 */
export interface AdminSubscriptionDto {
  subscriptionId: string;
  /** A Paddle status; typed loosely so a new one degrades instead of crashing. */
  status: string;
  priceId: string;
  productId: string;
  scheduledChangeAction: string | null;
  scheduledChangeAt: Date | null;
  /** Paddle's own creation time; null on rows not synced since the column. */
  paddleCreatedAt: Date | null;
  /** Next charge (or trial end); null when there is no future bill. */
  nextBilledAt: Date | null;
  /** When we first mirrored the row. */
  createdAt: Date;
  /** Last time a webhook or reconciliation touched it. */
  updatedAt: Date;
  business: AdminSubscriptionBusinessDto | null;
  customer: { customerId: string; email: string };
}

/** Platform-wide counts, so the tiles never disagree with the table filters. */
export interface AdminSubscriptionSummaryDto {
  total: number;
  active: number;
  trialing: number;
  pastDue: number;
  paused: number;
  canceled: number;
}

export interface AdminSubscriptionPageDto {
  subscriptions: AdminSubscriptionDto[];
  total: number;
  page: number;
  pageSize: number;
  summary: AdminSubscriptionSummaryDto;
}
