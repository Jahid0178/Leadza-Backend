import { z } from "zod";
import { checkServiceArea } from "../../services/servicearea.service";
import { defineTool } from "./types";

/**
 * checkServiceArea() — does the business cover this location? (FEATURES §24)
 * Delegates to the same deterministic matcher the public lead form uses, so
 * the AI can only report coverage the business actually configured — never an
 * invented one (§25).
 */
export const checkServiceAreaTool = defineTool({
  name: "checkServiceArea",
  description:
    "Check whether the business serves a postcode or place. Returns whether it " +
    "is covered and how it matched. Use it before confirming coverage.",
  parameters: {
    type: "object",
    properties: {
      postcode: { type: "string", description: "Customer postcode or district, e.g. 'RG1 4AB'." },
      place: { type: "string", description: "Town, city or area name, e.g. 'Reading'." },
      latitude: { type: "number", description: "Latitude, when known." },
      longitude: { type: "number", description: "Longitude, when known." },
    },
    additionalProperties: false,
  },
  schema: z
    .object({
      postcode: z.string().trim().min(2).max(12).optional(),
      place: z.string().trim().min(2).max(200).optional(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.postcode !== undefined ||
        value.place !== undefined ||
        (value.latitude !== undefined && value.longitude !== undefined),
      { message: "Provide a postcode, a place, or coordinates." },
    ),
  async handle(ctx, input) {
    const match = await checkServiceArea(ctx.businessId, input);
    return {
      ok: true,
      data: {
        inArea: match.inArea,
        matchedOn: match.matchedOn,
      },
    };
  },
});
