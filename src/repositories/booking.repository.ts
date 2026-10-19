import type {
  BookingDto,
  CreateBookingInput,
  ListBookingsQuery,
  UpdateBookingInput,
} from "../validation/booking.schemas";
import { prisma } from "../lib/prisma";
import { findMembership } from "./membership.repository";
import {
  ACTIVE_BOOKING_STATUSES,
  canTransitionBooking,
  type BookingStatus,
} from "../services/booking-status";
import {
  checkSlot,
  resolveBookingDuration,
  type SlotCheck,
} from "../services/availability.service";
import { canTransitionLead, type LeadStatus } from "../services/lead-status";
import { checkUsage } from "../services/usage.service";
import { publishBookingCreated, publishBookingUpdated } from "../realtime/hub";

/** Booking with the relations the calendar and detail views need (§35). */
export interface BookingWithRelations extends BookingDto {
  customer: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
  };
  service: { id: string; name: string } | null;
  lead: { id: string; status: string } | null;
}

/** A booking plus the caller's role for API responses. */
export interface BookingWithRole extends BookingWithRelations {
  role: "OWNER" | "ADMIN" | "STAFF";
}

/**
 * Tenant-scoped booking access (FEATURES §35, agent.md §13).
 * Every function verifies membership with the authenticated userId before
 * touching a row, so a businessId never comes from the client. Availability
 * is re-checked through the deterministic service, never trusted from input.
 */

type MemberRole = "OWNER" | "ADMIN" | "STAFF";

async function membershipRolesForUser(userId: string) {
  const memberships = await prisma.businessMember.findMany({
    where: { userId },
    select: { businessId: true, role: true },
  });
  return new Map(memberships.map((m) => [m.businessId, m.role]));
}

/** Prisma unique-constraint violation (the partial slot index). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

/** Attach customer + service + lead to booking rows. */
async function withRelations<T extends BookingDto>(
  bookings: T[],
): Promise<BookingWithRelations[]> {
  if (bookings.length === 0) return [];

  const [customers, services, leads] = await Promise.all([
    prisma.customer.findMany({
      where: { id: { in: bookings.map((b) => b.customerId) } },
      select: { id: true, name: true, phone: true, email: true },
    }),
    prisma.service.findMany({
      where: { id: { in: bookings.map((b) => b.serviceId).filter(Boolean) as string[] } },
      select: { id: true, name: true },
    }),
    prisma.lead.findMany({
      where: { id: { in: bookings.map((b) => b.leadId).filter(Boolean) as string[] } },
      select: { id: true, status: true },
    }),
  ]);

  const customerById = new Map(customers.map((c) => [c.id, c]));
  const serviceById = new Map(services.map((s) => [s.id, s]));
  const leadById = new Map(leads.map((l) => [l.id, l]));

  return bookings.map((booking) => ({
    ...booking,
    customer: customerById.get(booking.customerId) ?? {
      id: booking.customerId,
      name: "Unknown customer",
      phone: null,
      email: null,
    },
    service: booking.serviceId ? (serviceById.get(booking.serviceId) ?? null) : null,
    lead: booking.leadId ? (leadById.get(booking.leadId) ?? null) : null,
  })) as BookingWithRelations[];
}

/** Build the tenant-scoped Prisma where clause for a list query. */
function bookingWhere(query: {
  businessId: string | { in: string[] };
  status?: BookingStatus;
  leadId?: string;
  customerId?: string;
  from?: Date;
  to?: Date;
}) {
  const where: Record<string, unknown> = { businessId: query.businessId };
  if (query.status) where.status = query.status;
  if (query.leadId) where.leadId = query.leadId;
  if (query.customerId) where.customerId = query.customerId;
  if (query.from || query.to) {
    where.startAt = {
      ...(query.from ? { gte: query.from } : {}),
      ...(query.to ? { lte: query.to } : {}),
    };
  }
  return where;
}

/** List one business's bookings for the calendar range. */
export async function listBookingsForBusiness(
  userId: string,
  query: ListBookingsQuery,
  businessId: string,
): Promise<BookingWithRelations[] | null> {
  const membership = await findMembership(userId, businessId);
  if (!membership) return null;

  const rows = await prisma.booking.findMany({
    where: bookingWhere({ ...query, businessId }),
    orderBy: { startAt: "asc" },
  });
  return withRelations(rows);
}

/** List bookings across all the caller's businesses. */
export async function listBookingsForUser(
  userId: string,
  query: ListBookingsQuery,
): Promise<BookingWithRelations[]> {
  const roles = await membershipRolesForUser(userId);
  if (roles.size === 0) return [];

  const rows = await prisma.booking.findMany({
    where: bookingWhere({ ...query, businessId: { in: [...roles.keys()] } }),
    orderBy: { startAt: "asc" },
  });
  return withRelations(rows);
}

/** Read one booking if the caller is a member of its business. */
export async function findBookingForUser(
  userId: string,
  bookingId: string,
): Promise<BookingWithRole | null> {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking) return null;

  const membership = await findMembership(userId, booking.businessId);
  if (!membership) return null;

  const [withRel] = await withRelations([booking]);
  return withRel ? { ...withRel, role: membership.role } : null;
}

/**
 * Why a booking write was refused (§35). The three slot refusals stay apart
 * because they need different answers from the user: a taken slot means "pick
 * another time", a time outside opening hours means "that is past closing",
 * and a backwards range means "your end is before your start". Collapsing them
 * into one "unavailable" told the user their own appointment clashed with
 * itself.
 */
export type BookingRefusal =
  | { reason: "not_found" }
  | { reason: "unavailable" }
  | { reason: "end_before_start" }
  | { reason: "outside_hours"; openingHours: string[] }
  /** No active subscription, or the plan does not include booking (step 31). */
  | { reason: "subscription_required" }
  | {
      reason: "limit_reached";
      metric: "bookings";
      used: number;
      limit: number;
    };

/** Outcome of a create/reschedule: the booking or why it was refused. */
export type BookingMutationResult =
  | { ok: true; booking: BookingWithRole }
  | ({ ok: false } & BookingRefusal);

/** Result of the low-level create (tenancy already verified by the caller). */
export type ScopedBookingResult =
  | { ok: true; booking: BookingWithRelations }
  | ({ ok: false } & BookingRefusal);

export interface CreateBookingOptions {
  origin?: "AI" | "STAFF";
  createdById?: string | null;
}

/** A refused slot re-check, keeping the reason the service reported (§35). */
function slotRefusal(slot: SlotCheck): BookingRefusal {
  if (slot.reason === "outside_hours") {
    return { reason: "outside_hours", openingHours: slot.openingHours ?? [] };
  }
  return { reason: "unavailable" };
}

/**
 * Create a booking for a business whose tenancy is already verified — used by
 * the staff path (after a membership check) and by the AI tool (whose
 * businessId comes from the conversation context, never the model, §16).
 *
 * The customer/lead/service must belong to the same business (§13); the slot
 * is re-checked immediately before insert (§35); the partial unique index
 * rejects a race for the same slot. A booking linked to a lead moves it to
 * BOOKED through the lead transition table when allowed.
 */
export async function createBookingScoped(
  input: CreateBookingInput,
  options: CreateBookingOptions = {},
): Promise<ScopedBookingResult> {
  const customer = await prisma.customer.findFirst({
    where: { id: input.customerId, businessId: input.businessId },
    select: { id: true },
  });
  if (!customer) return { ok: false, reason: "not_found" };

  if (input.serviceId) {
    const service = await prisma.service.findFirst({
      where: { id: input.serviceId, businessId: input.businessId },
      select: { id: true },
    });
    if (!service) return { ok: false, reason: "not_found" };
  }

  if (input.leadId) {
    const lead = await prisma.lead.findFirst({
      where: { id: input.leadId, businessId: input.businessId },
      select: { id: true, status: true },
    });
    if (!lead) return { ok: false, reason: "not_found" };
  }

  // Plan allowance (FEATURES §48, step 31). This is the single create path for
  // staff and the AI, so one check covers both. It runs after ownership checks
  // (a foreign id still answers 404) and before the slot check, so an
  // exhausted plan is never reported as a misleading slot clash.
  const usage = await checkUsage(input.businessId, "bookings");
  if (!usage.allowed) {
    if (usage.reason === "subscription_required") {
      return { ok: false, reason: "subscription_required" };
    }
    return {
      ok: false,
      reason: "limit_reached",
      metric: "bookings",
      used: usage.used,
      limit: usage.limit,
    };
  }

  const durationMinutes = await resolveBookingDuration(input.businessId, input.serviceId);
  const startAt = input.startAt;
  const endAt = input.endAt ?? new Date(startAt.getTime() + durationMinutes * 60_000);

  const slot = await checkSlot({ businessId: input.businessId, startAt, endAt });
  if (!slot.available) return { ok: false, ...slotRefusal(slot) };

  let created;
  try {
    created = await prisma.booking.create({
      data: {
        businessId: input.businessId,
        customerId: input.customerId,
        leadId: input.leadId ?? null,
        serviceId: input.serviceId ?? null,
        startAt,
        endAt,
        status: input.status,
        origin: options.origin ?? "STAFF",
        notes: input.notes ?? null,
        createdById: options.createdById ?? null,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "unavailable" };
    throw err;
  }

  // A booked lead advances through the backend-owned lead lifecycle (§19).
  if (input.leadId && (ACTIVE_BOOKING_STATUSES as readonly string[]).includes(input.status)) {
    const lead = await prisma.lead.findUnique({
      where: { id: input.leadId },
      select: { status: true },
    });
    if (lead && canTransitionLead(lead.status as LeadStatus, "BOOKED")) {
      await prisma.lead.update({
        where: { id: input.leadId },
        data: { status: "BOOKED" },
      });
    }
  }

  const [withRel] = await withRelations([created]);
  if (!withRel) return { ok: false, reason: "not_found" };

  publishBookingCreated(input.businessId, created);
  return { ok: true, booking: withRel };
}

/** Create a booking on behalf of an authenticated member. */
export async function createBookingForUser(
  userId: string,
  input: CreateBookingInput,
  options: CreateBookingOptions = {},
): Promise<BookingMutationResult> {
  const membership = await findMembership(userId, input.businessId);
  if (!membership) return { ok: false, reason: "not_found" };

  const result = await createBookingScoped(input, {
    origin: options.origin ?? "STAFF",
    createdById: options.createdById ?? userId,
  });
  if (!result.ok) return result;
  return { ok: true, booking: { ...result.booking, role: membership.role } };
}

/**
 * Reschedule or edit a booking (any member). The new slot is re-checked, so a
 * move can never double-book (§35).
 */
export async function updateBookingForUser(
  userId: string,
  bookingId: string,
  data: UpdateBookingInput,
): Promise<BookingMutationResult> {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking) return { ok: false, reason: "not_found" };

  const membership = await findMembership(userId, booking.businessId);
  if (!membership) return { ok: false, reason: "not_found" };

  if (data.serviceId) {
    const service = await prisma.service.findFirst({
      where: { id: data.serviceId, businessId: booking.businessId },
      select: { id: true },
    });
    if (!service) return { ok: false, reason: "not_found" };
  }

  const serviceId = data.serviceId !== undefined ? data.serviceId : booking.serviceId;

  // Duration precedence: explicit start+end > new service duration > keep.
  let startAt = data.startAt ?? booking.startAt;
  let endAt: Date;
  if (data.startAt && data.endAt) {
    endAt = data.endAt;
  } else if (data.endAt) {
    endAt = data.endAt;
  } else if (data.serviceId !== undefined) {
    const minutes = await resolveBookingDuration(booking.businessId, serviceId);
    endAt = new Date(startAt.getTime() + minutes * 60_000);
  } else if (data.startAt) {
    const durationMs = booking.endAt.getTime() - booking.startAt.getTime();
    endAt = new Date(startAt.getTime() + durationMs);
  } else {
    endAt = booking.endAt;
  }
  if (endAt.getTime() <= startAt.getTime()) return { ok: false, reason: "end_before_start" };

  const slot = await checkSlot({
    businessId: booking.businessId,
    startAt,
    endAt,
    excludeBookingId: booking.id,
  });
  if (!slot.available) return { ok: false, ...slotRefusal(slot) };

  let updated;
  try {
    updated = await prisma.booking.update({
      where: { id: booking.id },
      data: {
        startAt,
        endAt,
        ...(data.serviceId !== undefined ? { serviceId: data.serviceId } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "unavailable" };
    throw err;
  }

  const [withRel] = await withRelations([updated]);
  if (!withRel) return { ok: false, reason: "not_found" };

  publishBookingUpdated(booking.businessId, updated);
  return { ok: true, booking: { ...withRel, role: membership.role } };
}

/** Outcome of a status change: the booking or the rejection reason. */
export type BookingStatusResult =
  | { ok: true; booking: BookingWithRole }
  | { ok: false; reason: "not_found" | "invalid_transition" };

/**
 * Change a booking's status — the ONLY way status ever changes (agent.md §19).
 * A cancellation records when it happened.
 */
export async function changeBookingStatusForUser(
  userId: string,
  bookingId: string,
  to: BookingStatus,
): Promise<BookingStatusResult> {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking) return { ok: false, reason: "not_found" };

  const membership = await findMembership(userId, booking.businessId);
  if (!membership) return { ok: false, reason: "not_found" };

  if (!canTransitionBooking(booking.status as BookingStatus, to)) {
    return { ok: false, reason: "invalid_transition" };
  }

  const updated = await prisma.booking.update({
    where: { id: booking.id },
    data: {
      status: to,
      cancelledAt: to === "CANCELLED" ? new Date() : booking.cancelledAt,
    },
  });

  const [withRel] = await withRelations([updated]);
  if (!withRel) return { ok: false, reason: "not_found" };

  publishBookingUpdated(booking.businessId, updated);
  return { ok: true, booking: { ...withRel, role: membership.role } };
}
