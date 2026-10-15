import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { defineTool } from "./types";

/**
 * getServiceDetails() — one service's description, price and duration
 * (FEATURES §24). Scoped to the conversation's business, so a service id from
 * another tenant can never be read (agent.md §16).
 */
export const getServiceDetailsTool = defineTool({
  name: "getServiceDetails",
  description:
    "Look up one of the business's services by id or by name: description, " +
    "published price, price type and typical duration. This is the ONLY source " +
    "of pricing you may use.",
  parameters: {
    type: "object",
    properties: {
      serviceId: { type: "string", description: "The service's id, when known." },
      serviceName: {
        type: "string",
        description: "The service's name, when the id is not known.",
      },
    },
    additionalProperties: false,
  },
  schema: z
    .object({
      serviceId: z.string().trim().min(1).optional(),
      serviceName: z.string().trim().min(1).max(200).optional(),
    })
    .strict()
    .refine(
      (value) => value.serviceId !== undefined || value.serviceName !== undefined,
      { message: "Provide serviceId or serviceName." },
    ),
  async handle(ctx, input) {
    const service = await prisma.service.findFirst({
      where: {
        businessId: ctx.businessId,
        ...(input.serviceId
          ? { id: input.serviceId }
          : { name: { equals: input.serviceName, mode: "insensitive" } }),
      },
      select: {
        id: true,
        name: true,
        description: true,
        price: true,
        priceType: true,
        duration: true,
        active: true,
      },
    });
    if (!service) return { ok: false, error: "No matching service was found." };

    return {
      ok: true,
      data: {
        id: service.id,
        name: service.name,
        description: service.description,
        price: service.price,
        priceType: service.priceType,
        durationMinutes: service.duration,
        active: service.active,
      },
    };
  },
});
