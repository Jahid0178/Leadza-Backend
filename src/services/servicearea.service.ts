import { prisma } from "../lib/prisma";

/**
 * Internal service-area check (FEATURES §11, IMPLEMENTATION_PLAN step 10).
 *
 * Used by the AI tool (step 21) and the public lead form (step 18) to decide
 * whether a lead can potentially be served. `businessId` must already be
 * resolved server-side (session membership or a known public business ref) —
 * this helper is never exposed to client-supplied ids directly (§7, §52).
 *
 * Matching is deterministic and never guesses: postcode prefix, place name,
 * then radius from the business's own coordinates. No match means "we don't
 * cover that", so the AI can say so instead of inventing coverage (§25).
 */

export interface ServiceAreaQuery {
  /** Full postcode or postcode district, e.g. "RG1 4AB" or "RG1". */
  postcode?: string;
  /** Free-text place name, e.g. "Reading" or "Wokingham". */
  place?: string;
  /** Coordinates of the lead's location, for radius-based areas. */
  latitude?: number;
  longitude?: number;
}

export interface ServiceAreaMatch {
  inArea: boolean;
  matchedAreaId: string | null;
  matchedOn: "postcode" | "place" | "radius" | null;
}

/** Strip all spaces and uppercase: "rg1 4ab" → "RG14AB". */
function normalizePostcode(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/**
 * UK outward code of a full postcode: "RG14AB" → "RG1". A short value like
 * "RG1" is already an outward code, so it is returned unchanged.
 */
function outwardCode(postcode: string): string {
  const compact = normalizePostcode(postcode);
  // A UK full postcode's inward code is always the last 3 characters.
  return compact.length >= 5 ? compact.slice(0, -3) : compact;
}

/** Collapse case/whitespace so "  reading " matches "Reading". */
function normalizePlace(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Words that cannot identify a place on their own. A stored area labelled
 * "Savar Service Area" and a customer who says "Savar, near the bus stand"
 * should still match, so filler words are ignored when comparing tokens.
 */
const PLACE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "at", "by", "to",
  "near", "next", "opposite", "behind", "beside", "between",
  "area", "town", "city", "village", "district", "region", "county", "suburb",
  "service", "services", "coverage", "covered", "zone",
  "road", "street", "lane", "avenue", "close", "drive", "way", "place",
  "bus", "stop", "stand", "station", "market", "centre", "center",
  "postcode", "postal", "code",
]);

/** A shared token must be at least this long to count as a place match. */
const MIN_SHARED_TOKEN_LENGTH = 4;

/** Lowercased words of a place, punctuation treated as whitespace. */
function placeTokens(value: string): string[] {
  return normalizePlace(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** Place tokens with the generic filler words removed. */
function significantPlaceTokens(value: string): string[] {
  const tokens = placeTokens(value).filter((token) => !PLACE_STOPWORDS.has(token));
  // Everything was generic ("town") — fall back so an exact match still works.
  return tokens.length > 0 ? tokens : placeTokens(value);
}

/**
 * Place-name match, tolerant of the way people write locations.
 *
 * Exact equality first; failing that, a shared *significant* token must carry
 * the match — so "Savar" finds a stored "Savar Service Area", and "Savar, near
 * the bus stand" finds "Savar Dhaka town", while "Bathgate" still does not
 * match "Bath" (tokens are compared whole) and a query of pure filler ("the
 * town") matches nothing. Postcodes are handled separately and never compared
 * as places.
 */
function placeMatches(storedValue: string, wanted: string): boolean {
  const stored = normalizePlace(storedValue);
  const query = normalizePlace(wanted);
  if (stored === query) return true;

  const storedTokens = new Set(significantPlaceTokens(stored));
  return significantPlaceTokens(query).some(
    (token) =>
      token.length >= MIN_SHARED_TOKEN_LENGTH && storedTokens.has(token),
  );
}

/** Great-circle distance in kilometers. */
function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const NO_MATCH: ServiceAreaMatch = {
  inArea: false,
  matchedAreaId: null,
  matchedOn: null,
};

/**
 * Checks whether a location falls inside the business's configured service
 * areas. Returns the first deterministic match — never an invented one.
 */
export async function checkServiceArea(
  businessId: string,
  query: ServiceAreaQuery,
): Promise<ServiceAreaMatch> {
  const areas = await prisma.serviceArea.findMany({
    where: { businessId },
    orderBy: { value: "asc" },
  });
  if (areas.length === 0) return NO_MATCH;

  // 1. Postcode: exact outward-code match against the stored value.
  const postcode = query.postcode?.trim();
  if (postcode) {
    const compact = normalizePostcode(postcode);
    const outward = outwardCode(postcode);
    const match = areas.find((area) => {
      const stored = normalizePostcode(area.value);
      return stored === compact || stored === outward;
    });
    if (match) {
      return { inArea: true, matchedAreaId: match.id, matchedOn: "postcode" };
    }
  }

  // 2. Place name: tolerant match against value or label, so "Savar" matches a
  // stored "Savar Dhaka town" and "Savar, near the bus stand" matches too.
  const place = query.place?.trim();
  if (place) {
    const match = areas.find(
      (area) =>
        placeMatches(area.value, place) ||
        (area.label !== null && placeMatches(area.label, place)),
    );
    if (match) {
      return { inArea: true, matchedAreaId: match.id, matchedOn: "place" };
    }
  }

  // 3. Radius: within radiusKm of the business's own coordinates.
  if (
    typeof query.latitude === "number" &&
    typeof query.longitude === "number"
  ) {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { latitude: true, longitude: true },
    });
    if (
      business &&
      business.latitude !== null &&
      business.longitude !== null
    ) {
      const distance = haversineKm(
        business.latitude,
        business.longitude,
        query.latitude,
        query.longitude,
      );
      const radiusAreas = areas.filter(
        (area) => area.radiusKm !== null && distance <= area.radiusKm,
      );
      const match = radiusAreas.sort(
        (a, b) => (a.radiusKm ?? 0) - (b.radiusKm ?? 0),
      )[0];
      if (match) {
        return { inArea: true, matchedAreaId: match.id, matchedOn: "radius" };
      }
    }
  }

  return NO_MATCH;
}
