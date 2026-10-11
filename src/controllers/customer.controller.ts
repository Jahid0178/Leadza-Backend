import type { Request, Response } from "express";
import {
  findCustomerForUser,
  findOrCreateCustomerForUser,
  listCustomersForBusiness,
  listCustomersForUser,
} from "../repositories/customer.repository";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";
import { parseAfterAuth, requireMembership } from "../utils/business-access";
import {
  findOrCreateCustomerSchema,
  type CustomerDto,
} from "../validation/customer.schemas";

/**
 * Customer controller (FEATURES §14, IMPLEMENTATION_PLAN step 13).
 *
 * Reads are available to any member (STAFF included) — customers are the
 * context every conversation shows. Find-or-create is also member-wide: it
 * is how the lead pipeline (step 18) and the AI tools (step 21) attach a
 * person to a lead, not a privileged configuration change.
 */

function requireUserId(req: Request): string {
  const user = req.user;
  if (!user) {
    throw ApiError.unauthorized("UNAUTHENTICATED", "You need to sign in to continue.");
  }
  return user.id;
}

function customerIdParam(req: Request): string {
  const customerId = req.params.customerId;
  if (typeof customerId !== "string") {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  return customerId;
}

function businessIdQuery(req: Request): string | undefined {
  const value = req.query.businessId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * GET /api/v1/customers — the caller's customers across their businesses, or
 * one business's customers when ?businessId is supplied.
 */
export async function listCustomers(req: Request, res: Response) {
  const userId = requireUserId(req);
  const businessId = businessIdQuery(req);

  if (businessId) {
    // Membership decides visibility — a foreign businessId yields 404 (§13).
    await requireMembership(userId, businessId);
    const customers = await listCustomersForBusiness(userId, businessId);
    res.json(
      apiSuccess({ customers: customers.map((c) => ({ ...toCustomerDto(c), role: c.role })) }),
    );
    return;
  }

  const customers = await listCustomersForUser(userId);
  res.json(
    apiSuccess({ customers: customers.map((c) => ({ ...toCustomerDto(c), role: c.role })) }),
  );
}

/** GET /api/v1/customers/:customerId — verified members only (404 otherwise). */
export async function getCustomer(req: Request, res: Response) {
  const userId = requireUserId(req);
  const customer = await findCustomerForUser(userId, customerIdParam(req));

  if (!customer) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(
    apiSuccess({ customer: { ...toCustomerDto(customer), role: customer.role } }),
  );
}

/**
 * POST /api/v1/customers — find a customer by (businessId, phone|email) or
 * create it. Any member may call this; a non-member's businessId yields 404.
 */
export async function findOrCreateCustomer(req: Request, res: Response) {
  const userId = requireUserId(req);

  // Authorization before payload validation (§14): resolve the tenant from
  // the raw body first so an unauthorized caller can't probe validation.
  const rawBusinessId = (req.body as { businessId?: unknown } | null)?.businessId;
  if (typeof rawBusinessId !== "string" || rawBusinessId.length === 0) {
    throw ApiError.badRequest("VALIDATION_ERROR", "businessId: Business is required.");
  }
  await requireMembership(userId, rawBusinessId);

  const input = parseAfterAuth(findOrCreateCustomerSchema, req.body);

  const result = await findOrCreateCustomerForUser(userId, input);
  if (!result) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  const status = result.created ? 201 : 200;
  res
    .status(status)
    .json(
      apiSuccess({
        customer: { ...toCustomerDto(result.customer), role: result.customer.role },
        created: result.created,
      }),
    );
}

/** Safe customer DTO — only fields meant for the API (agent.md §26). */
function toCustomerDto(customer: CustomerDto) {
  return customer;
}
