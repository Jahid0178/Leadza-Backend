import { z } from "zod";

export const weekdaySchema = z.enum([
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
]);

const timeSchema = z
  .string()
  .trim()
  .regex(/^\d{2}:\d{2}$/, "Use 24-hour format, e.g. 08:00 or 18:00.")
  .max(5, "Time must look like HH:MM.");

/** POST /api/v1/businesses/:businessId/hours — add business hours. */
export const createBusinessHourSchema = z
  .object({
    businessId: z.string().trim().min(1, "Business is required."),
    weekday: weekdaySchema,
    startTime: timeSchema,
    endTime: timeSchema,
    orderIndex: z
      .number()
      .int("Order index must be a whole number.")
      .min(0, "Order index must be 0 or more.")
      .optional()
      .default(0),
    closed: z.boolean().optional().default(false),
    emergency: z.boolean().optional().default(false),
  })
  .refine(
    (values) => values.startTime !== values.endTime || values.closed,
    {
      message: "Closed days should be marked closed.",
      path: ["endTime"],
    },
  );

export type CreateBusinessHourInput = z.infer<typeof createBusinessHourSchema>;

/** PATCH /api/v1/hours/:hourId — at least one editable field required. */
export const updateBusinessHourSchema = z
  .object({
    weekday: weekdaySchema.optional(),
    startTime: timeSchema.optional(),
    endTime: timeSchema.optional(),
    orderIndex: z
      .number()
      .int("Order index must be a whole number.")
      .min(0, "Order index must be 0 or more.")
      .optional(),
    closed: z.boolean().optional(),
    emergency: z.boolean().optional(),
  })
  .refine(
    (values) => {
      const keys = [
        "weekday",
        "startTime",
        "endTime",
        "orderIndex",
        "closed",
        "emergency",
      ] as const;
      return keys.some((key) => values[key] !== undefined);
    },
    { message: "No fields to update." },
  )
  .refine(
    (values) =>
      values.closed !== true ||
      (values.startTime === undefined && values.endTime === undefined),
    {
      message: "Closed days should not have start/end times.",
      path: ["startTime"],
    },
  );

export type UpdateBusinessHourInput = z.infer<typeof updateBusinessHourSchema>;

/** Public business-hour shape returned by the backend. */
export interface BusinessHourDto {
  id: string;
  businessId: string;
  weekday: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY";
  startTime: string;
  endTime: string;
  orderIndex: number;
  closed: boolean;
  emergency: boolean;
  createdAt: Date;
  updatedAt: Date;
}
