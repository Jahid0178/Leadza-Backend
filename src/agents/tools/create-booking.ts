import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { formatTimeInTz } from "../../services/availability.service";
import { createBookingScoped } from "../../repositories/booking.repository";
import { defineTool } from "./types";

/**
 * createBooking() — book the customer into a slot they agreed to (FEATURES
 * §24, §35). It may only be called for a slot returned by checkAvailability:
 * the backend re-checks the slot immediately before insert, so a stale offer
 * fails safely rather than double-booking. The booking is owned by the
 * conversation's business/customer (§16) and recorded as AI-origin.
 */

const DEFAULT_TZ = "Europe/London";

export const createBookingTool = defineTool({
  name: "createBooking",
  description:
    "Book an appointment for this customer at a specific slot. Only call it " +
    "with a start time that checkAvailability just returned and the customer " +
    "agreed to. The backend re-checks the slot before confirming.",
  parameters: {
    type: "object",
    properties: {
      startAt: { type: "string", description: "Chosen slot start (ISO 8601)." },
      serviceId: { type: "string", description: "Service the booking is for, when known." },
      notes: { type: "string", description: "Short note about the job." },
    },
    required: ["startAt"],
    additionalProperties: false,
  },
  schema: z
    .object({
      startAt: z.coerce.date(),
      serviceId: z.string().trim().min(1).optional(),
      notes: z.string().trim().max(2000).optional(),
    })
    .strict(),
  async handle(ctx, input) {
    if (!ctx.customerId) {
      return { ok: false, denied: true, error: "There is no customer on this conversation." };
    }

    const result = await createBookingScoped(
      {
        businessId: ctx.businessId,
        customerId: ctx.customerId,
        leadId: ctx.leadId,
        serviceId: input.serviceId ?? null,
        startAt: input.startAt,
        status: "PENDING",
        notes: input.notes ?? null,
      },
      { origin: "AI" },
    );

    if (!result.ok) {
      if (result.reason === "outside_hours") {
        return {
          ok: false,
          error:
            "That time is outside the opening hours — call checkAvailability and offer a time it returns.",
        };
      }
      if (result.reason === "unavailable") {
        return { ok: false, error: "That slot is no longer available — check again for another." };
      }
      if (
        result.reason === "subscription_required" ||
        result.reason === "limit_reached"
      ) {
        return {
          ok: false,
          error:
            "Online appointment booking isn't available right now. Tell the customer " +
            "a member of the team will contact them to confirm a time — never claim a " +
            "time is already booked.",
        };
      }
      return {
        ok: false,
        denied: true,
        error: "The booking could not be created for this business.",
      };
    }

    const business = await prisma.business.findUnique({
      where: { id: ctx.businessId },
      select: { timezone: true },
    });
    const timezone = business?.timezone || DEFAULT_TZ;
    const time = formatTimeInTz(result.booking.startAt, timezone);

    return {
      ok: true,
      data: {
        booking: {
          id: result.booking.id,
          startAt: result.booking.startAt.toISOString(),
          endAt: result.booking.endAt.toISOString(),
          status: result.booking.status,
          serviceId: result.booking.serviceId,
        },
        time,
        timezone,
        allowedTimes: [time],
      },
    };
  },
});
