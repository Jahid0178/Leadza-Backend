import {
  countActivePlatformAdmins,
  findUserForAdmin,
  setBusinessStatusForAdmin,
  setPlatformRoleForAdmin,
  setUserStatusForAdmin,
  type AdminActor,
  type SetBusinessStatusResult,
  type SetPlatformRoleResult,
  type SetUserResult,
} from "../repositories/admin.repository";
import { ApiError } from "../utils/api-error";
import type {
  AdminUserDetailDto,
  BusinessStatusInput,
  PlatformRoleInput,
  UserStatusInput,
} from "../validation/admin.schemas";

/**
 * Rules for the platform admin area (FEATURES §40–43, IMPLEMENTATION_PLAN
 * step 28). The repository does the writing; every guard rail that could lock
 * an operator out of the platform lives here, in one readable place.
 *
 * Four things the admin UI can never do, however it is driven:
 *   - suspend its own account (SELF_SUSPEND_NOT_ALLOWED),
 *   - remove its own platform access (SELF_DEMOTION_NOT_ALLOWED),
 *   - demote or suspend the last active administrator (LAST_PLATFORM_ADMIN),
 *   - reach a tenant through these endpoints — they are platform-wide by
 *     design and only exist behind `requirePlatformAdmin` (§5, §13).
 */

export async function setBusinessStatus(
  actor: AdminActor,
  businessId: string,
  status: BusinessStatusInput,
): Promise<SetBusinessStatusResult> {
  // Suspension itself always blocks the tenant's API (services/business-status),
  // so there is nothing extra to enforce here — the change is audited.
  return setBusinessStatusForAdmin(businessId, status, actor);
}

export async function setUserStatus(
  actor: AdminActor,
  userId: string,
  status: UserStatusInput,
): Promise<SetUserResult> {
  if (status === "SUSPENDED" && actor.id === userId) {
    throw ApiError.forbidden(
      "SELF_SUSPEND_NOT_ALLOWED",
      "You cannot suspend your own account.",
    );
  }
  return setUserStatusForAdmin(userId, status, actor);
}

/** The lookups the platform-role rules need — injectable for unit tests. */
export interface PlatformRoleGuardDeps {
  countActivePlatformAdmins: () => Promise<number>;
  findUserForAdmin: (userId: string) => Promise<AdminUserDetailDto | null>;
}

const defaultPlatformRoleDeps: PlatformRoleGuardDeps = {
  countActivePlatformAdmins,
  findUserForAdmin,
};

export async function setPlatformRole(
  actor: AdminActor,
  userId: string,
  platformRole: PlatformRoleInput,
  deps: PlatformRoleGuardDeps = defaultPlatformRoleDeps,
): Promise<SetPlatformRoleResult> {
  if (platformRole === "USER" && actor.id === userId) {
    throw ApiError.forbidden(
      "SELF_DEMOTION_NOT_ALLOWED",
      "You cannot remove your own platform administrator access.",
    );
  }

  if (platformRole === "USER") {
    const target = await deps.findUserForAdmin(userId);
    if (!target) return { ok: false, reason: "not_found" };

    // Only an *active* administrator can be locked out by this change.
    if (target.platformRole === "PLATFORM_ADMIN" && target.status === "ACTIVE") {
      const admins = await deps.countActivePlatformAdmins();
      if (admins <= 1) {
        throw ApiError.conflict(
          "LAST_PLATFORM_ADMIN",
          "This is the last active platform administrator. Promote another account first.",
        );
      }
    }
  }

  return setPlatformRoleForAdmin(userId, platformRole, actor);
}
