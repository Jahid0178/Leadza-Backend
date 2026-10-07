/**
 * Shared auth domain types.
 * Values mirror the Prisma enums in prisma/schema.prisma — keep in sync.
 */
export type PlatformRole = "USER" | "PLATFORM_ADMIN";
export type MemberRole = "OWNER" | "ADMIN" | "STAFF";

/** The only user shape ever exposed over the API (no password hash, no internals). */
export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  platformRole: PlatformRole;
}
