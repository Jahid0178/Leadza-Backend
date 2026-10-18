import { z } from "zod";
import {
  formatTimeInTz,
  getAvailableSlots,
} from "../../services/availability.service";
import { defineTool } from "./types";

/**
 * checkAvailability() — the real free slots for a date range (FEATURES §24,
 * §34–35). The answer is computed from the business's own opening hours and
 * existing bookings, so the AI can only ever offer a time a source reports
 * (§25). `allowedTimes` is returned for the reply guardrail: a clock time the
 * model states is only permitted if it came back from here.
 */

const MAX_SLOTS = 20;
const MAX_RANGE_MS = 14 * 24 * 60 * 60 * 1000;

export const checkAvailabilityTool = defineTool({
  name: "checkAvailability",
  description:
    "List the business's real free appointment slots between two dates. " +
    "Only offer the customer times returned by this tool — never invent a " +
    "time. Call it again if the requested window changes.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "Start of the window (ISO 8601)." },
      to: { type: "string", description: "End of the window (ISO 8601)." },
      serviceId: { type: "string", description: "Service the slot is for, when known." },
    },
    required: ["from", "to"],
    additionalProperties: false,
  },
  schema: z
    .object({
      from: z.coerce.date(),
      to: z.coerce.date(),
      serviceId: z.string().trim().min(1).optional(),
    })
    .strict(),
  async handle(ctx, input) {
    if (input.to.getTime() <= input.from.getTime()) {
      return { ok: false, denied: true, error: "The end must be after the start." };
    }

    const cappedTo = new Date(
      Math.min(input.to.getTime(), input.from.getTime() + MAX_RANGE_MS),
    );

    const result = await getAvailableSlots({
      businessId: ctx.businessId,
      from: input.from,
      to: cappedTo,
      serviceId: input.serviceId ?? null,
    });

    const slots = result.slots.slice(0, MAX_SLOTS).map((slot) => ({
      startAt: slot.startAt.toISOString(),
      endAt: slot.endAt.toISOString(),
      time: formatTimeInTz(slot.startAt, result.timezone),
    }));

    return {
      ok: true,
      data: {
        timezone: result.timezone,
        durationMinutes: result.durationMinutes,
        slots,
        allowedTimes: [...new Set(slots.map((slot) => slot.time))],
      },
    };
  },
});
