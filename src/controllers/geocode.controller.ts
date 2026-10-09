import { z } from "zod";
import type { Request, Response } from "express";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";
import { searchPlaces } from "../services/geocoder.service";

const searchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(3, "Search must be at least 3 characters.")
    .max(200, "Search must be 200 characters or fewer."),
});

/**
 * GET /api/v1/geocode/search?q= — address autocomplete backed by Nominatim.
 * Query params are validated here (req.query is read-only in Express 5).
 * Upstream failures surface as an empty list — the address field stays
 * usable as plain text (§58).
 */
export async function search(req: Request, res: Response) {
  const parsed = searchQuerySchema.safeParse({ q: req.query.q });
  if (!parsed.success) {
    throw ApiError.badRequest(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Invalid search query.",
    );
  }

  const places = await searchPlaces(parsed.data.q);
  res.json(apiSuccess({ places }));
}
