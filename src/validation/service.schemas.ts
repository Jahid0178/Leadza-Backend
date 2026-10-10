import { z } from "zod";

/** Service pricing model (FEATURES §10). */
export const priceTypeSchema = z.enum(["FIXED", "FROM", "FREE", "CUSTOM"]);

/** Bounds shared by create and update schemas for readability. */
const nameSchema = z
  .string()
  .trim()
  .min(2, "Service name must be at least 2 characters.")
  .max(100, "Service name must be 100 characters or fewer.");

const descriptionSchema = z
  .string()
  .trim()
  .max(2000, "Service description must be 2000 characters or fewer.")
  .nullable()
  .optional();

const priceSchema = z
  .number()
  .min(0, "Price must be 0 or more.")
  .nullable()
  .optional();

const durationSchema = z
  .number()
  .int("Duration must be a whole number.")
  .min(0, "Duration must be 0 or more.")
  .nullable()
  .optional();

/** POST /api/v1/services — create a service under a business. */
export const createServiceSchema = z.object({
  businessId: z.string().trim().min(1, "Business is required."),
  name: nameSchema,
  description: descriptionSchema,
  price: priceSchema,
  priceType: priceTypeSchema.default("FIXED"),
  duration: durationSchema,
});

export type CreateServiceInput = z.infer<typeof createServiceSchema>;

/** PATCH /api/v1/services/:id — at least one editable field required. */
export const updateServiceSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema,
    price: priceSchema,
    priceType: priceTypeSchema.optional(),
    duration: durationSchema,
    active: z
      .boolean()
      .optional()
      .nullable()
      .transform((value) => (value === undefined ? undefined : value)),
  })
  .refine(
    (values) => {
      const keys = [
        "name",
        "description",
        "price",
        "priceType",
        "duration",
        "active",
      ] as const;
      return keys.some(
        (key) =>
          values[key] !== undefined &&
          values[key] !== null &&
          values[key] !== "",
      );
    },
    { message: "No fields to update." },
  );

export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;

/** Convenience type for Prisma `where` usage in repositories. */
export type ServiceWhereUniqueInput = { id: string };

/**
 * Public service shape returned by the backend.
 * Kept separate from Prisma types so controllers only expose intended fields.
 */
export interface ServiceDto {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  price: number | null;
  priceType: "FIXED" | "FROM" | "FREE" | "CUSTOM";
  duration: number | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}
