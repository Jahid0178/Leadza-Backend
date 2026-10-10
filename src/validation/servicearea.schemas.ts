import { z } from "zod";

/** POST /api/v1/businesses/:businessId/areas — add a service area. */
export const createServiceAreaSchema = z
  .object({
    businessId: z.string().trim().min(1, "Business is required."),
    value: z
      .string()
      .trim()
      .min(1, "Service area is required.")
      .max(100, "Service area must be 100 characters or fewer."),
    label: z
      .string()
      .trim()
      .max(100, "Label must be 100 characters or fewer.")
      .nullable()
      .optional(),
    radiusKm: z
      .number()
      .int("Radius must be a whole number.")
      .min(0, "Radius must be 0 or more.")
      .nullable()
      .optional(),
  })
  .refine(
    (values) => values.value.length >= 1,
    { message: "Service area is required." },
  );

export type CreateServiceAreaInput = z.infer<typeof createServiceAreaSchema>;

/** PATCH /api/v1/areas/:areaId — at least one editable field required. */
export const updateServiceAreaSchema = z
  .object({
    value: z
      .string()
      .trim()
      .min(1, "Service area is required.")
      .max(100, "Service area must be 100 characters or fewer.")
      .optional(),
    label: z
      .string()
      .trim()
      .max(100, "Label must be 100 characters or fewer.")
      .nullable()
      .optional(),
    radiusKm: z
      .number()
      .int("Radius must be a whole number.")
      .min(0, "Radius must be 0 or more.")
      .nullable()
      .optional(),
  })
  .refine(
    (values) => {
      const keys = ["value", "label", "radiusKm"] as const;
      return keys.some(
        (key) =>
          values[key] !== undefined &&
          values[key] !== null &&
          (typeof values[key] === "string"
            ? values[key].trim().length > 0
            : true),
      );
    },
    { message: "No fields to update." },
  );

export type UpdateServiceAreaInput = z.infer<typeof updateServiceAreaSchema>;

/** Public service-area shape returned by the backend. */
export interface ServiceAreaDto {
  id: string;
  businessId: string;
  value: string;
  label: string | null;
  radiusKm: number | null;
  createdAt: Date;
  updatedAt: Date;
}
