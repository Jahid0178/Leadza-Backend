import { z } from "zod";

/**
 * POST /api/v1/leads/public/:businessRef — the embeddable website form
 * (FEATURES §21, IMPLEMENTATION_PLAN step 18). No authentication: the
 * caller is an anonymous website visitor, so the payload carries only the
 * §21 form fields and nothing tenant-trusted (the business comes from the
 * URL, validated server-side against ACTIVE status).
 *
 * `website` is a honeypot: real visitors never see or fill it (the widget
 * hides the input), bots commonly do. The controller treats a filled
 * honeypot as a plausible success without creating anything, so bots get
 * no signal that they were dropped.
 */
export const publicLeadSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Enter your name.")
      .max(120, "Name must be 120 characters or fewer."),
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
    /** Free-text service request — matched to an active service by name. */
    serviceName: z
      .string()
      .trim()
      .max(120, "Service must be 120 characters or fewer.")
      .nullable()
      .optional(),
    /** The widget's service select — validated in-tenant before linking (§13). */
    serviceId: z
      .string()
      .trim()
      .min(1)
      .max(64, "Service must be 64 characters or fewer.")
      .optional(),
    urgency: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
    preferredDate: z.coerce.date().optional(),
    postcode: z
      .string()
      .trim()
      .max(12, "Postcode must be 12 characters or fewer.")
      .nullable()
      .optional(),
    message: z
      .string()
      .trim()
      .min(1, "Enter a short description of what you need.")
      .max(4000, "Message must be 4000 characters or fewer."),
    /** Honeypot — see the doc comment above. */
    website: z.string().max(500).optional(),
  })
  .refine((values) => values.email != null || values.phone != null, {
    message: "Add a phone number or email so we can reply.",
    path: ["phone"],
  });

export type PublicLeadInput = z.infer<typeof publicLeadSchema>;

/** Minimal safe lead shape for the public response (agent.md §26). */
export interface PublicLeadResult {
  lead: { id: string; status: string; createdAt: Date };
  conversation: { id: string; status: string } | null;
}
