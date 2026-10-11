import { z } from "zod";
import type { LeadStatus } from "../services/lead-status";

/** Lead sources (FEATURES §16). */
export const leadSourceSchema = z.enum([
  "WEBSITE",
  "WHATSAPP",
  "EMAIL",
  "SMS",
  "FACEBOOK",
  "INSTAGRAM",
]);

/** Urgency levels (FEATURES §17 example: "Urgency: High"). */
export const leadUrgencySchema = z.enum(["LOW", "MEDIUM", "HIGH"]);

/** All lifecycle statuses — validated transitions live in lead-status.ts. */
export const leadStatusSchema = z.enum([
  "NEW",
  "CONTACTED",
  "QUALIFYING",
  "QUALIFIED",
  "BOOKED",
  "WON",
  "LOST",
  "SPAM",
  "CANCELLED",
]);

const postcodeSchema = z
  .string()
  .trim()
  .max(12, "Postcode must be 12 characters or fewer.")
  .nullable()
  .optional();

/** POST /api/v1/leads — create a lead for a customer (§15, manual entry). */
export const createLeadSchema = z.object({
  businessId: z.string().trim().min(1, "Business is required."),
  customerId: z.string().trim().min(1, "Customer is required."),
  serviceId: z.string().trim().min(1).nullable().optional(),
  source: leadSourceSchema.default("WEBSITE"),
  urgency: leadUrgencySchema.nullable().optional(),
  location: z
    .string()
    .trim()
    .max(200, "Location must be 200 characters or fewer.")
    .nullable()
    .optional(),
  postcode: postcodeSchema,
  budget: z
    .number()
    .min(0, "Budget must be 0 or more.")
    .nullable()
    .optional(),
  preferredDate: z.coerce.date().nullable().optional(),
  preferredTime: z
    .string()
    .trim()
    .max(40, "Preferred time must be 40 characters or fewer.")
    .nullable()
    .optional(),
  customerMessage: z
    .string()
    .trim()
    .max(4000, "Message must be 4000 characters or fewer.")
    .nullable()
    .optional(),
});

export type CreateLeadInput = z.infer<typeof createLeadSchema>;

/**
 * PATCH /api/v1/leads/:leadId — qualification fields; status excluded.
 * `.strict()`: an unrecognized field (notably `status`) is an error, not a
 * silent strip — there is no path from this endpoint to a status change
 * (agent.md §19).
 */
export const updateLeadSchema = z
  .object({
    serviceId: z.string().trim().min(1).nullable().optional(),
    urgency: leadUrgencySchema.nullable().optional(),
    location: z
      .string()
      .trim()
      .max(200, "Location must be 200 characters or fewer.")
      .nullable()
      .optional(),
    postcode: postcodeSchema,
    budget: z
      .number()
      .min(0, "Budget must be 0 or more.")
      .nullable()
      .optional(),
    preferredDate: z.coerce.date().nullable().optional(),
    preferredTime: z
      .string()
      .trim()
      .max(40, "Preferred time must be 40 characters or fewer.")
      .nullable()
      .optional(),
    customerMessage: z
      .string()
      .trim()
      .max(4000, "Message must be 4000 characters or fewer.")
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (values) => Object.values(values).some((value) => value !== undefined),
    { message: "No fields to update." },
  );

export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

/** PATCH /api/v1/leads/:leadId/status — body of the status endpoint. */
export const changeLeadStatusSchema = z.object({
  status: leadStatusSchema,
}).strict();

export type ChangeLeadStatusInput = z.infer<typeof changeLeadStatusSchema>;

/**
 * GET /api/v1/leads — list query (§29: search + status/urgency/service/
 * source/date/score filters, plus pagination).
 */
export const listLeadsQuerySchema = z.object({
  businessId: z.string().trim().min(1).optional(),
  status: leadStatusSchema.optional(),
  urgency: leadUrgencySchema.optional(),
  source: leadSourceSchema.optional(),
  serviceId: z.string().trim().min(1).optional(),
  customerId: z.string().trim().min(1).optional(),
  /** Inclusive ISO date bounds on createdAt, e.g. 2026-10-01. */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Inclusive score bounds (§29 "Lead score" filter). */
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
  /** Free-text search over customer name/phone/email/postcode/message. */
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;

/** Public lead shape returned by the backend (agent.md §26). */
export interface LeadDto {
  id: string;
  businessId: string;
  customerId: string;
  serviceId: string | null;
  status: LeadStatus;
  source: "WEBSITE" | "WHATSAPP" | "EMAIL" | "SMS" | "FACEBOOK" | "INSTAGRAM";
  urgency: "LOW" | "MEDIUM" | "HIGH" | null;
  location: string | null;
  postcode: string | null;
  budget: number | null;
  preferredDate: Date | null;
  preferredTime: string | null;
  customerMessage: string | null;
  leadScore: number | null;
  createdAt: Date;
  updatedAt: Date;
}
