import type {
  CustomerDto,
  FindOrCreateCustomerInput,
} from "../validation/customer.schemas";
import { prisma } from "../lib/prisma";
import { findMembership } from "./membership.repository";

/** A customer plus the caller's role for API responses. */
export interface CustomerWithRole extends CustomerDto {
  role: "OWNER" | "ADMIN" | "STAFF";
}

/**
 * Tenant-scoped customer access (FEATURES §14, agent.md §13).
 * Every function verifies membership with the authenticated userId before
 * touching the row, so a businessId never comes from the client.
 */

/**
 * Phone numbers are matched after stripping formatting characters so
 * "07700 900123" and "07700-900123" resolve to the same customer.
 */
function normalizePhone(phone: string): string {
  return phone.replace(/[\s()\-.+]/g, "");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Caller's businessId → verified role, resolved server-side. */
async function membershipRolesForUser(userId: string) {
  const memberships = await prisma.businessMember.findMany({
    where: { userId },
    select: { businessId: true, role: true },
  });
  return new Map(memberships.map((m) => [m.businessId, m.role]));
}

/** List customers across all the caller's businesses (most recent first). */
export async function listCustomersForUser(
  userId: string,
): Promise<CustomerWithRole[]> {
  const roles = await membershipRolesForUser(userId);
  if (roles.size === 0) return [];

  const customers = await prisma.customer.findMany({
    where: { businessId: { in: [...roles.keys()] } },
    orderBy: { createdAt: "desc" },
  });

  const rows = customers.map((customer) => {
    const role = roles.get(customer.businessId);
    return role ? ({ ...customer, role } as CustomerWithRole) : null;
  });

  return rows.filter((r): r is CustomerWithRole => r !== null);
}

/** List customers for one business the caller belongs to. */
export async function listCustomersForBusiness(
  userId: string,
  businessId: string,
): Promise<CustomerWithRole[]> {
  const membership = await findMembership(userId, businessId);
  if (!membership) return [];

  const customers = await prisma.customer.findMany({
    where: { businessId },
    orderBy: { createdAt: "desc" },
  });

  return customers.map((customer) => ({
    ...customer,
    role: membership.role,
  }));
}

/** Read one customer if the caller is a member of its business. */
export async function findCustomerForUser(
  userId: string,
  customerId: string,
): Promise<CustomerWithRole | null> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
  });
  if (!customer) return null;

  const membership = await findMembership(userId, customer.businessId);
  if (!membership) return null;

  return { ...customer, role: membership.role };
}

/**
 * Find a customer by (businessId, phone) or (businessId, email) — the
 * internal key the lead pipeline (step 18) uses before creating a lead.
 */
export async function findCustomerByIdentity(
  businessId: string,
  identity: { phone?: string | null; email?: string | null },
): Promise<CustomerDto | null> {
  if (identity.phone) {
    const phone = normalizePhone(identity.phone);
    const customers = await prisma.customer.findMany({
      where: { businessId, phone: { not: null } },
    });
    const match = customers.find((c) => c.phone !== null && normalizePhone(c.phone) === phone);
    if (match) return match;
  }

  if (identity.email) {
    const email = normalizeEmail(identity.email);
    const customers = await prisma.customer.findMany({
      where: { businessId, email: { not: null } },
    });
    const match = customers.find((c) => c.email !== null && normalizeEmail(c.email) === email);
    if (match) return match;
  }

  return null;
}

/**
 * Find a customer by phone/email within a business the caller belongs to, or
 * create it. Returns `null` when the caller is not a member (404 upstream).
 */
export async function findOrCreateCustomerForUser(
  userId: string,
  input: FindOrCreateCustomerInput,
): Promise<{ customer: CustomerWithRole; created: boolean } | null> {
  const membership = await findMembership(userId, input.businessId);
  if (!membership) return null;

  const existing = await findCustomerByIdentity(input.businessId, {
    phone: input.phone,
    email: input.email,
  });
  if (existing) {
    return { customer: { ...existing, role: membership.role }, created: false };
  }

  const customer = await prisma.customer.create({
    data: {
      businessId: input.businessId,
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      postcode: input.postcode ?? null,
      address: input.address ?? null,
    },
  });

  return { customer: { ...customer, role: membership.role }, created: true };
}
