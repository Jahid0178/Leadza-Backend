import { z } from "zod";

/**
 * Business profile validation (FEATURES §8, agent.md §14).
 * Nullable fields may be cleared with an explicit `null`; omitted keys are
 * left untouched (PATCH semantics).
 */

const nameSchema = z
  .string()
  .trim()
  .min(2, "Business name must be at least 2 characters.")
  .max(100, "Business name must be 100 characters or fewer.");

const typeSchema = z
  .string()
  .trim()
  .min(2, "Business type must be at least 2 characters.")
  .max(60, "Business type must be 60 characters or fewer.");

/** POST /api/v1/businesses — create with the basics; profile is filled in via PATCH. */
export const createBusinessSchema = z.object({
  name: nameSchema,
  type: typeSchema.optional(),
});

/** PATCH /api/v1/businesses/:businessId — at least one known field required. */
export const updateBusinessSchema = z
  .object({
    name: nameSchema.optional(),
    type: typeSchema.nullable().optional(),
    website: z
      .url("Enter a valid URL, including https://")
      .nullable()
      .optional(),
    phone: z
      .string()
      .trim()
      .min(5, "Enter a valid phone number.")
      .max(30, "Phone number must be 30 characters or fewer.")
      .nullable()
      .optional(),
    email: z.email("Enter a valid email address.").nullable().optional(),
    address: z
      .string()
      .trim()
      .min(3, "Enter a valid address.")
      .max(200, "Address must be 200 characters or fewer.")
      .nullable()
      .optional(),
    description: z
      .string()
      .trim()
      .max(2000, "Description must be 2000 characters or fewer.")
      .nullable()
      .optional(),
    latitude: z
      .number()
      .min(-90, "Latitude must be between -90 and 90.")
      .max(90, "Latitude must be between -90 and 90.")
      .nullable()
      .optional(),
    longitude: z
      .number()
      .min(-180, "Longitude must be between -180 and 180.")
      .max(180, "Longitude must be between -180 and 180.")
      .nullable()
      .optional(),
  })
  .refine((values) => Object.keys(values).length > 0, {
    message: "No fields to update.",
  });

export type CreateBusinessInput = z.infer<typeof createBusinessSchema>;
export type UpdateBusinessInput = z.infer<typeof updateBusinessSchema>;
