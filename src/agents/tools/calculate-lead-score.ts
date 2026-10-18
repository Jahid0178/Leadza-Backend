import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { scoreLead } from "../../services/lead-score.service";
import { checkServiceArea } from "../../services/servicearea.service";
import { defineTool } from "./types";

/**
 * calculateLeadScore() — score the conversation's lead (FEATURES §18, §24).
 * The score is computed by the backend's deterministic rules (never by the
 * model) and persisted on the lead. Scoped to the conversation's business.
 *
 * The area factor (§18) is decided here, where the server-resolved
 * businessId is known: `checkServiceArea()` asks the business's own
 * configured areas, so the score never assumes coverage the business did not
 * define (§25).
 */
export const calculateLeadScoreTool = defineTool({
  name: "calculateLeadScore",
  description:
    "Recalculate and store the lead score (0-100) from the details collected so " +
    "far, returning the contributing factors. Call it after learning new lead " +
    "details. The score is computed by the backend, not by you.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  schema: z.object({}).strict(),
  async handle(ctx) {
    if (!ctx.leadId) {
      return { ok: false, error: "There is no lead on this conversation to score." };
    }

    const lead = await prisma.lead.findUnique({
      where: { id: ctx.leadId },
      include: { customer: { select: { phone: true, email: true } } },
    });
    if (!lead) return { ok: false, error: "Lead not found." };
    if (lead.businessId !== ctx.businessId) {
      return { ok: false, denied: true, error: "That lead does not belong to this business." };
    }

    // Area match (§18): a lead with no location yet scores nothing for this
    // factor instead of being assumed covered.
    const area =
      lead.postcode || lead.location
        ? await checkServiceArea(lead.businessId, {
            postcode: lead.postcode ?? undefined,
            place: lead.location ?? undefined,
          })
        : null;

    const result = scoreLead(
      lead,
      {
        phone: lead.customer.phone,
        email: lead.customer.email,
      },
      { areaCovered: area?.inArea ?? null },
    );

    await prisma.lead.update({
      where: { id: lead.id },
      data: { leadScore: result.score },
    });

    return { ok: true, data: result };
  },
});