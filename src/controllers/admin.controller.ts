import type { Request, Response } from "express";
import { readAdminAiUsage } from "../services/ai-usage.service";
import {
  findBusinessForAdmin,
  findUserForAdmin,
  getPlatformOverview,
  listAuditLogsForAdmin,
  listBusinessesForAdmin,
  listSubscriptionsForAdmin,
  listUsersForAdmin,
  type AdminActor,
} from "../repositories/admin.repository";
import { setBusinessStatus, setPlatformRole, setUserStatus } from "../services/admin.service";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";
import { parseAfterAuth } from "../utils/business-access";
import {
  changeBusinessStatusSchema,
  changePlatformRoleSchema,
  changeUserStatusSchema,
  listAdminBusinessesQuerySchema,
  listAdminSubscriptionsQuerySchema,
  listAdminUsageQuerySchema,
  listAdminUsersQuerySchema,
  listAuditLogsQuerySchema,
} from "../validation/admin.schemas";

/**
 * Platform admin controller (FEATURES §40–43, §45; IMPLEMENTATION_PLAN
 * steps 28–29).
 *
 * Every handler runs behind `requireAuth, requirePlatformAdmin`
 * (routes/admin.routes.ts) — the platform role is re-read from the database on
 * each request, so a demotion or suspension is effective immediately. These
 * endpoints are platform-wide and therefore deliberately cross-tenant; the
 * business-scoped controllers keep their membership-derived tenant scope.
 *
 * Validation runs after authorization (§14) and before any query.
 */

/** Who is acting — the verified session user, never a client-supplied id. */
function requireActor(req: Request): AdminActor {
  const user = req.user;
  if (!user) {
    // requireAuth already rejects anonymous requests; defensive guard only.
    throw ApiError.unauthorized("UNAUTHENTICATED", "You need to sign in to continue.");
  }
  return { id: user.id, email: user.email };
}

/** A required :param, answering 404 when it is absent. */
function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  return value;
}

/** GET /api/v1/admin/status — platform-admin access probe (§5). */
export function status(req: Request, res: Response) {
  const user = req.user;
  if (!user) {
    // requireAuth already rejects anonymous requests; defensive guard only.
    throw ApiError.unauthorized("UNAUTHENTICATED", "You need to sign in to continue.");
  }
  res.json(apiSuccess({ role: user.platformRole }));
}

/** GET /api/v1/admin/overview — §41 platform-wide statistics. */
export async function overview(_req: Request, res: Response) {
  res.json(apiSuccess({ overview: await getPlatformOverview() }));
}

/** GET /api/v1/admin/businesses — §42 search + status filter + pagination. */
export async function listBusinesses(req: Request, res: Response) {
  const query = parseAfterAuth(listAdminBusinessesQuerySchema, req.query);
  const page = await listBusinessesForAdmin(query);
  res.json(
    apiSuccess({
      businesses: page.businesses,
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    }),
  );
}

/** GET /api/v1/admin/businesses/:businessId — §42 profile, members, audit. */
export async function getBusiness(req: Request, res: Response) {
  const business = await findBusinessForAdmin(param(req, "businessId"));
  if (!business) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  res.json(apiSuccess({ business }));
}

/** PATCH /api/v1/admin/businesses/:businessId/status — suspend / restore (§42). */
export async function changeBusinessStatus(req: Request, res: Response) {
  const actor = requireActor(req);
  const businessId = param(req, "businessId");
  const input = parseAfterAuth(changeBusinessStatusSchema, req.body);

  const result = await setBusinessStatus(actor, businessId, input.status);
  if (!result.ok) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(
    apiSuccess({
      business: result.business,
      changed: result.changed,
      previousStatus: result.previousStatus,
    }),
  );
}

/** GET /api/v1/admin/users — §43 search + role/status/business filters. */
export async function listUsers(req: Request, res: Response) {
  const query = parseAfterAuth(listAdminUsersQuerySchema, req.query);
  const page = await listUsersForAdmin(query);
  res.json(
    apiSuccess({
      users: page.users,
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    }),
  );
}

/** GET /api/v1/admin/users/:userId — §43 account + memberships + activity. */
export async function getUser(req: Request, res: Response) {
  const user = await findUserForAdmin(param(req, "userId"));
  if (!user) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  res.json(apiSuccess({ user }));
}

/** PATCH /api/v1/admin/users/:userId/status — suspend / restore (§43). */
export async function changeUserStatus(req: Request, res: Response) {
  const actor = requireActor(req);
  const userId = param(req, "userId");
  const input = parseAfterAuth(changeUserStatusSchema, req.body);

  const result = await setUserStatus(actor, userId, input.status);
  if (!result.ok) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(
    apiSuccess({
      user: result.user,
      changed: result.changed,
      previousStatus: result.previousStatus,
    }),
  );
}

/** PATCH /api/v1/admin/users/:userId/platform-role — §43 role management. */
export async function changePlatformRole(req: Request, res: Response) {
  const actor = requireActor(req);
  const userId = param(req, "userId");
  const input = parseAfterAuth(changePlatformRoleSchema, req.body);

  const result = await setPlatformRole(actor, userId, input.platformRole);
  if (!result.ok) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(
    apiSuccess({
      user: result.user,
      changed: result.changed,
      previousRole: result.previousRole,
    }),
  );
}

/** GET /api/v1/admin/audit-logs — §45 read-only trail, newest first. */
export async function listAuditLogs(req: Request, res: Response) {
  const query = parseAfterAuth(listAuditLogsQuerySchema, req.query);
  const page = await listAuditLogsForAdmin(query);
  res.json(
    apiSuccess({
      logs: page.logs,
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    }),
  );
}

/**
 * GET /api/v1/admin/subscriptions — every mirrored Paddle subscription.
 *
 * Phase H billing: who bought what, from which tenant, and where each
 * subscription stands. Read-only — plan changes belong to the customer portal,
 * and nothing here mutates billing state.
 */
export async function listSubscriptions(req: Request, res: Response) {
  const query = parseAfterAuth(listAdminSubscriptionsQuerySchema, req.query);
  const page = await listSubscriptionsForAdmin(query);
  res.json(
    apiSuccess({
      subscriptions: page.subscriptions,
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      summary: page.summary,
    }),
  );
}

/**
 * GET /api/v1/admin/usage — §49 AI usage, per business, for the current UTC
 * month (step 32). Read-only reporting: the limits themselves are enforced by
 * `services/usage.service.ts` at the AI/booking paths, never in the frontend.
 */
export async function listUsage(req: Request, res: Response) {
  const query = parseAfterAuth(listAdminUsageQuerySchema, req.query);
  res.json(apiSuccess(await readAdminAiUsage(query)));
}
