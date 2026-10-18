import { z } from "zod";
import type { BookingStatus } from "../services/booking-status";

/** Every booking status — transitions are validated in booking-status.ts. */
export const bookingStatusSchema = z.enum([
  "PENDING",
  "CONFIRMED",
  "CANCELLED",
  "COMPLETED",
  "NO_SHOW",
]);

/** Who created the booking (FEATURES §35). */
export const bookingOriginSchema = z.enum(["AI", "STAFF"]);

/**
 * POST /api/v1/bookings — create an appointment (FEATURES §35). `customerId`
 * is required (a booking is always for someone); a linked lead/service is
 * optional. `endAt` may be omitted so the backend derives it from the
 * service duration (or the configured default).
 */
export const createBookingSchema = z
  .object({
    businessId: z.string().trim().min(1, "Business is required."),
    customerId: z.string().trim().min(1, "Customer is required."),
    leadId: z.string().trim().min(1).nullable().optional(),
    serviceId: z.string().trim().min(1).nullable().optional(),
    startAt: z.coerce.date(),
    endAt: z.coerce.date().optional(),
    status: z.enum(["PENDING", "CONFIRMED"]).default("CONFIRMED"),
    notes: z
      .string()
      .trim()
      .max(2000, "Notes must be 2000 characters or fewer.")
      .nullable()
      .optional(),
  })
  // A backwards range is the caller's mistake, so it is refused as bad input
  // rather than silently rewritten into some other appointment length. No
  // `path`: the message already names both fields, and the controller prefixes
  // a path to the text it shows the user.
  .refine((values) => !values.endAt || values.endAt.getTime() > values.startAt.getTime(), {
    message: "The end time must be after the start time.",
  });

export type CreateBookingInput = z.infer<typeof createBookingSchema>;

/**
 * PATCH /api/v1/bookings/:bookingId — reschedule or edit notes. Status is
 * deliberately excluded: only the status endpoint may move a booking
 * (agent.md §19).
 */
export const updateBookingSchema = z
  .object({
    startAt: z.coerce.date().optional(),
    endAt: z.coerce.date().optional(),
    serviceId: z.string().trim().min(1).nullable().optional(),
    notes: z
      .string()
      .trim()
      .max(2000, "Notes must be 2000 characters or fewer.")
      .nullable()
      .optional(),
  })
  .strict()
  .refine((values) => Object.values(values).some((value) => value !== undefined), {
    message: "No fields to update.",
  })
  // Only when both ends are supplied: one alone means "keep the other side".
  .refine(
    (values) =>
      !values.startAt ||
      !values.endAt ||
      values.endAt.getTime() > values.startAt.getTime(),
    { message: "The end time must be after the start time." },
  );

export type UpdateBookingInput = z.infer<typeof updateBookingSchema>;

/** PATCH /api/v1/bookings/:bookingId/status — the only status endpoint. */
export const changeBookingStatusSchema = z
  .object({ status: bookingStatusSchema })
  .strict();

export type ChangeBookingStatusInput = z.infer<typeof changeBookingStatusSchema>;

/**
 * GET /api/v1/bookings — list the calendar's bookings for a range. `businessId`
 * is optional (all the caller's businesses when omitted), mirroring leads.
 */
export const listBookingsQuerySchema = z.object({
  businessId: z.string().trim().min(1).optional(),
  status: bookingStatusSchema.optional(),
  leadId: z.string().trim().min(1).optional(),
  customerId: z.string().trim().min(1).optional(),
  /** Inclusive range on startAt (the calendar's visible window). */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;

/** GET /api/v1/bookings/availability — free slots for a range. */
export const availabilityQuerySchema = z.object({
  businessId: z.string().trim().min(1, "Business is required."),
  serviceId: z.string().trim().min(1).optional(),
  from: z.coerce.date(),
  to: z.coerce.date(),
});

export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

/** Public booking shape returned by the backend (agent.md §26). */
export interface BookingDto {
  id: string;
  businessId: string;
  customerId: string;
  leadId: string | null;
  serviceId: string | null;
  startAt: Date;
  endAt: Date;
  status: BookingStatus;
  origin: "AI" | "STAFF";
  notes: string | null;
  createdById: string | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
