import { z } from "zod";

/** POST /api/v1/customers — find-or-create a customer (FEATURES §14). */
export const findOrCreateCustomerSchema = z
  .object({
    businessId: z.string().trim().min(1, "Business is required."),
    name: z
      .string()
      .trim()
      .min(1, "Customer name is required.")
      .max(120, "Customer name must be 120 characters or fewer."),
    email: z
      .email("Enter a valid email address.")
      .max(254, "Email must be 254 characters or fewer.")
      .nullable()
      .optional(),
    phone: z
      .string()
      .trim()
      .min(5, "Phone number must be at least 5 characters.")
      .max(30, "Phone number must be 30 characters or fewer.")
      .nullable()
      .optional(),
    postcode: z
      .string()
      .trim()
      .max(12, "Postcode must be 12 characters or fewer.")
      .nullable()
      .optional(),
    address: z
      .string()
      .trim()
      .max(500, "Address must be 500 characters or fewer.")
      .nullable()
      .optional(),
  })
  .refine(
    (values) => values.email != null || values.phone != null,
    {
      message: "A phone number or email is required so the customer can be matched later.",
      path: ["phone"],
    },
  );

export type FindOrCreateCustomerInput = z.infer<
  typeof findOrCreateCustomerSchema
>;

/**
 * Public customer shape returned by the backend (agent.md §26) — only fields
 * meant for the API, never internal ids of other tenants.
 */
export interface CustomerDto {
  id: string;
  businessId: string;
  name: string;
  email: string | null;
  phone: string | null;
  postcode: string | null;
  address: string | null;
  createdAt: Date;
  updatedAt: Date;
}
