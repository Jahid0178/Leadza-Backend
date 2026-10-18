import type { Prisma } from "../../generated/prisma/client";
import { prisma } from "../lib/prisma";

/**
 * Audit trail for sensitive platform actions (FEATURES §45,
 * IMPLEMENTATION_PLAN step 29).
 *
 * Two rules make the log trustworthy:
 *   1. **Append-only.** Nothing in this module updates or deletes, and no API
 *      route exposes either — history is written once and read back.
 *   2. **Written with the action.** Callers pass the surrounding Prisma
 *      transaction client, so a status change and its audit entry commit
 *      together: an audited action cannot happen unaudited, and an entry
 *      cannot describe a change that was rolled back.
 *
 * The allowed actions are a TypeScript union rather than a database enum:
 * Phase H adds subscriptions, integrations and impersonation, and a new
 * audited action should not need a migration.
 */

export const AUDIT_ACTIONS = [
  "business.suspended",
  "business.restored",
  "user.suspended",
  "user.restored",
  "user.platform_role_changed",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** What an entry points at. Kept in step with the `action` prefixes. */
export const AUDIT_RESOURCE_TYPES = ["business", "user"] as const;

export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number];

/** JSON-safe action detail, e.g. `{ from: "ACTIVE", to: "SUSPENDED" }`. */
export type AuditMetadata = Record<string, string | number | boolean | null>;

export interface AuditEntryInput {
  /** The platform administrator who acted (never a client-supplied id). */
  actorId: string;
  actorEmail: string;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string;
  /** The tenant the action touched; null for platform-level actions. */
  businessId?: string | null;
  metadata?: AuditMetadata;
}

/** Either the root client or a transaction client. */
type AuditClient = Prisma.TransactionClient;

/**
 * Append one audit entry. Pass `tx` from inside a `prisma.$transaction` so the
 * entry commits with the change it describes.
 */
export async function recordAudit(
  input: AuditEntryInput,
  client: AuditClient = prisma,
): Promise<void> {
  await client.auditLog.create({
    data: {
      actorId: input.actorId,
      actorEmail: input.actorEmail,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      businessId: input.businessId ?? null,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
  });
}
