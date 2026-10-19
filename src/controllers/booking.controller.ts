import type { Request, Response } from "express";
import {
  changeBookingStatusForUser,
  createBookingForUser,
  findBookingForUser,
  listBookingsForBusiness,
  listBookingsForUser,
  updateBookingForUser,
  type BookingRefusal,
} from "../repositories/booking.repository";
import { getAvailableSlots } from "../services/availability.service";
import {
  SUBSCRIPTION_REQUIRED,
  USAGE_LIMIT_REACHED,
  limitReachedMessage,
  subscriptionRequiredMessage,
} from "../services/usage.service";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";
import { parseAfterAuth, requireMembership } from "../utils/business-access";
import {
  availabilityQuerySchema,
  changeBookingStatusSchema,
  createBookingSchema,
  listBookingsQuerySchema,
  updateBookingSchema,
} from "../validation/booking.schemas";

/**
 * Booking controller (FEATURES §34–35, IMPLEMENTATION_PLAN step 27).
 *
 * Bookings are the operational work of the business, so any member may create,
 * reschedule or cancel one (mirroring lead status changes, §Phase C). Status
 * moves are validated by the backend-owned table (agent.md §19); a slot is
 * always re-checked so the frontend can never force a double-booking (§35).
 */

function requireUserId(req: Request): string {
  const user = req.user;
  if (!user) {
    throw ApiError.unauthorized("UNAUTHENTICATED", "You need to sign in to continue.");
  }
  return user.id;
}

function bookingIdParam(req: Request): string {
  const bookingId = req.params.bookingId;
  if (typeof bookingId !== "string") {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }
  return bookingId;
}

/** 409 for a slot that is not actually available (§25, §35). */
function unavailable(): ApiError {
  return ApiError.conflict(
    "BOOKING_UNAVAILABLE",
    "That appointment time is no longer available.",
  );
}

/**
 * A refused write, told apart by cause. Both a taken slot and a time outside
 * opening hours are 409s, but they lead the user to different places — "pick
 * another slot" versus "that is past closing" — so they carry different codes
 * and messages (§25, §35).
 */
function refuseBooking(refusal: BookingRefusal): never {
  if (refusal.reason === "outside_hours") {
    throw ApiError.conflict("BOOKING_OUTSIDE_HOURS", outsideHoursMessage(refusal.openingHours));
  }
  if (refusal.reason === "end_before_start") {
    throw ApiError.badRequest("VALIDATION_ERROR", "The end time must be after the start time.");
  }
  if (refusal.reason === "unavailable") throw unavailable();
  if (refusal.reason === "subscription_required") {
    throw ApiError.forbidden(
      SUBSCRIPTION_REQUIRED,
      subscriptionRequiredMessage("bookings"),
    );
  }
  if (refusal.reason === "limit_reached") {
    throw ApiError.conflict(
      USAGE_LIMIT_REACHED,
      limitReachedMessage("bookings", refusal.limit),
    );
  }
  throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
}

/** "That's past closing" — naming the hours, so the limit is obvious. */
function outsideHoursMessage(openingHours: string[]): string {
  if (openingHours.length === 0) {
    return "That time is outside the business's opening hours — none are set for that day.";
  }
  return `That time is outside the business's opening hours (${openingHours.join(", ")}).`;
}

/** GET /api/v1/bookings — the calendar's bookings for a range (§35). */
export async function listBookings(req: Request, res: Response) {
  const userId = requireUserId(req);

  const parsed = listBookingsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    throw ApiError.badRequest(
      "VALIDATION_ERROR",
      field ? `${field}: ${issue?.message}` : (issue?.message ?? "Invalid query."),
    );
  }
  const query = parsed.data;

  if (query.businessId) {
    const bookings = await listBookingsForBusiness(userId, query, query.businessId);
    if (!bookings) {
      throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
    }
    res.json(apiSuccess({ bookings }));
    return;
  }

  const bookings = await listBookingsForUser(userId, query);
  res.json(apiSuccess({ bookings }));
}

/** GET /api/v1/bookings/availability — free slots for a range (§35). */
export async function listAvailability(req: Request, res: Response) {
  const userId = requireUserId(req);

  const parsed = availabilityQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    throw ApiError.badRequest(
      "VALIDATION_ERROR",
      field ? `${field}: ${issue?.message}` : (issue?.message ?? "Invalid query."),
    );
  }
  const query = parsed.data;

  // Membership decides visibility — a foreign businessId yields 404 (§13).
  await requireMembership(userId, query.businessId);

  const result = await getAvailableSlots({
    businessId: query.businessId,
    serviceId: query.serviceId ?? null,
    from: query.from,
    to: query.to,
  });

  res.json(
    apiSuccess({
      timezone: result.timezone,
      durationMinutes: result.durationMinutes,
      slots: result.slots.map((slot) => ({
        startAt: slot.startAt.toISOString(),
        endAt: slot.endAt.toISOString(),
      })),
    }),
  );
}

/** GET /api/v1/bookings/:bookingId — verified members only (404 otherwise). */
export async function getBooking(req: Request, res: Response) {
  const userId = requireUserId(req);
  const booking = await findBookingForUser(userId, bookingIdParam(req));

  if (!booking) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(apiSuccess({ booking }));
}

/**
 * POST /api/v1/bookings — create an appointment. The customer must belong to
 * the same business; the slot is re-checked before insert (§35).
 */
export async function createBooking(req: Request, res: Response) {
  const userId = requireUserId(req);

  // Authorization before payload validation (§14).
  const rawBusinessId = (req.body as { businessId?: unknown } | null)?.businessId;
  if (typeof rawBusinessId !== "string" || rawBusinessId.length === 0) {
    throw ApiError.badRequest("VALIDATION_ERROR", "businessId: Business is required.");
  }
  await requireMembership(userId, rawBusinessId);

  const input = parseAfterAuth(createBookingSchema, req.body);

  const result = await createBookingForUser(userId, input);
  if (!result.ok) refuseBooking(result);

  res.status(201).json(apiSuccess({ booking: result.booking }));
}

/** PATCH /api/v1/bookings/:bookingId — reschedule or edit notes. */
export async function updateBooking(req: Request, res: Response) {
  const userId = requireUserId(req);

  const existing = await findBookingForUser(userId, bookingIdParam(req));
  if (!existing) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  const input = parseAfterAuth(updateBookingSchema, req.body);

  const result = await updateBookingForUser(userId, existing.id, input);
  if (!result.ok) refuseBooking(result);

  res.json(apiSuccess({ booking: result.booking }));
}

/**
 * PATCH /api/v1/bookings/:bookingId/status — the only endpoint that changes a
 * booking's status. Invalid jumps are rejected with INVALID_TRANSITION.
 */
export async function changeBookingStatus(req: Request, res: Response) {
  const userId = requireUserId(req);

  const existing = await findBookingForUser(userId, bookingIdParam(req));
  if (!existing) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  const input = parseAfterAuth(changeBookingStatusSchema, req.body);

  const result = await changeBookingStatusForUser(userId, existing.id, input.status);
  if (!result.ok) {
    if (result.reason === "invalid_transition") {
      throw ApiError.badRequest(
        "INVALID_TRANSITION",
        `A booking cannot move from ${existing.status} to ${input.status}.`,
      );
    }
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  res.json(apiSuccess({ booking: result.booking }));
}
