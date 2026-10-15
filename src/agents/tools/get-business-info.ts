import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { defineTool } from "./types";

/**
 * getBusinessInfo() — the business's public profile (FEATURES §24).
 * Read-only and scoped to the conversation's business, so it can only ever
 * reveal facts the customer is already talking to (agent.md §16).
 */
export const getBusinessInfoTool = defineTool({
  name: "getBusinessInfo",
  description:
    "Look up the business's public profile: name, description, contact details, " +
    "service areas and opening hours. Use this to answer general questions about " +
    "the business instead of guessing.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  schema: z.object({}).strict(),
  async handle(ctx) {
    const business = await prisma.business.findUnique({
      where: { id: ctx.businessId },
      select: {
        name: true,
        type: true,
        description: true,
        phone: true,
        email: true,
        website: true,
        currency: true,
      },
    });
    if (!business) return { ok: false, error: "Business not found." };

    const [areas, hours] = await Promise.all([
      prisma.serviceArea.findMany({
        where: { businessId: ctx.businessId },
        orderBy: { value: "asc" },
        select: { value: true, label: true },
      }),
      prisma.businessHour.findMany({
        where: { businessId: ctx.businessId },
        orderBy: [{ weekday: "asc" }, { orderIndex: "asc" }],
        select: { weekday: true, startTime: true, endTime: true, closed: true },
      }),
    ]);

    return {
      ok: true,
      data: {
        name: business.name,
        type: business.type,
        description: business.description,
        phone: business.phone,
        email: business.email,
        website: business.website,
        currency: business.currency,
        serviceAreas: areas.map((area) => area.label ?? area.value),
        openingHours: hours.map((hour) =>
          hour.closed
            ? `${hour.weekday}: closed`
            : `${hour.weekday}: ${hour.startTime}-${hour.endTime}`,
        ),
      },
    };
  },
});
