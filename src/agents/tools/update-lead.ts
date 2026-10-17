import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { defineTool } from "./types";

/**
 * updateLead() — record qualification fields the customer supplied (FEATURES
 * §24, agent.md §16, §20).
 *
 * The model may name a lead, but ownership is decided here: the lead must
 * belong to the conversation's business, and any reassigned service must too.
 * Status is deliberately absent — the backend-owned lifecycle (§19) is the
 * only path to a status change. Model output never reaches the DB directly.
 */
export const updateLeadTool = defineTool({
  name: "updateLead",
  description:
    "Record lead details the customer has given: service, urgency, location, " +
    "postcode, budget, preferred date/time, or the original message. Only pass " +
    "fields the customer actually provided.",
  parameters: {
    type: "object",
    properties: {
      leadId: { type: "string", description: "Target lead id; defaults to this conversation's lead." },
      serviceId: { type: "string", description: "Service id the customer is asking about." },
      urgency: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"], description: "How urgent the job is." },
      location: { type: "string", description: "Town/city the job is at." },
      postcode: { type: "string", description: "Job postcode." },
      budget: { type: "number", description: "Budget the customer mentioned." },
      preferredDate: { type: "string", description: "Preferred appointment date (ISO 8601)." },
      preferredTime: { type: "string", description: "Preferred appointment time." },
      customerMessage: { type: "string", description: "The customer's original enquiry text." },
    },
    additionalProperties: false,
  },
  schema: z
    .object({
      leadId: z.string().trim().min(1).optional(),
      serviceId: z.string().trim().min(1).nullable().optional(),
      urgency: z.enum(["LOW", "MEDIUM", "HIGH"]).nullable().optional(),
      location: z.string().trim().max(200).nullable().optional(),
      postcode: z.string().trim().max(12).nullable().optional(),
      budget: z.number().min(0).nullable().optional(),
      preferredDate: z.coerce.date().nullable().optional(),
      preferredTime: z.string().trim().max(40).nullable().optional(),
      customerMessage: z.string().trim().max(4000).nullable().optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.serviceId !== undefined ||
        value.urgency !== undefined ||
        value.location !== undefined ||
        value.postcode !== undefined ||
        value.budget !== undefined ||
        value.preferredDate !== undefined ||
        value.preferredTime !== undefined ||
        value.customerMessage !== undefined,
      { message: "No lead fields to update." },
    ),
  async handle(ctx, input) {
    const leadId = input.leadId ?? ctx.leadId;
    if (!leadId) {
      return { ok: false, error: "There is no lead on this conversation to update." };
    }

    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, businessId: true },
    });
    if (!lead) return { ok: false, error: "Lead not found." };
    if (lead.businessId !== ctx.businessId) {
      return { ok: false, denied: true, error: "That lead does not belong to this business." };
    }

    // A reassigned service must belong to the same business (§13, §16).
    if (input.serviceId) {
      const service = await prisma.service.findFirst({
        where: { id: input.serviceId, businessId: ctx.businessId },
        select: { id: true },
      });
      if (!service) {
        return { ok: false, denied: true, error: "That service does not belong to this business." };
      }
    }

    const updated = await prisma.lead.update({
      where: { id: lead.id },
      data: {
        ...(input.serviceId !== undefined ? { serviceId: input.serviceId } : {}),
        ...(input.urgency !== undefined ? { urgency: input.urgency } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(input.postcode !== undefined ? { postcode: input.postcode } : {}),
        ...(input.budget !== undefined ? { budget: input.budget } : {}),
        ...(input.preferredDate !== undefined ? { preferredDate: input.preferredDate } : {}),
        ...(input.preferredTime !== undefined ? { preferredTime: input.preferredTime } : {}),
        ...(input.customerMessage !== undefined
          ? { customerMessage: input.customerMessage }
          : {}),
      },
      select: {
        id: true,
        serviceId: true,
        urgency: true,
        location: true,
        postcode: true,
        budget: true,
        preferredDate: true,
        preferredTime: true,
        status: true,
      },
    });

    return { ok: true, data: updated };
  },
});
