/**
 * Address search via OpenStreetMap Nominatim (§3 integrations live in the
 * backend; agent.md §49). Doc: https://nominatim.org/release-docs/develop/api/Search/
 *
 * Nominatim's public instance allows at most ~1 request/second and asks for a
 * descriptive User-Agent; the frontend debounces before calling us, and
 * responses are cached here so repeat queries never leave the backend.
 * If usage grows, self-host Nominatim or switch to a commercial provider —
 * don't hammer the public endpoint (usage policy).
 */

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "Leadza-Backend/0.1 (address search)";
const TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

export interface PlaceSuggestion {
  id: number;
  label: string;
  latitude: number;
  longitude: number;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface CacheEntry {
  at: number;
  results: PlaceSuggestion[];
}

const cache = new Map<string, CacheEntry>();

/** Minimal raw shape of a Nominatim jsonv2 result. */
interface RawPlace {
  place_id?: unknown;
  lat?: unknown;
  lon?: unknown;
  display_name?: unknown;
}

function normalize(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Exposed for tests: cache contents keyed by normalized query. */
export function geocoderCache(): Map<string, CacheEntry> {
  return cache;
}

function pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at > CACHE_TTL_MS) cache.delete(key);
  }
  if (cache.size > CACHE_MAX_ENTRIES) cache.clear();
}

function parseResults(payload: unknown): PlaceSuggestion[] {
  if (!Array.isArray(payload)) return [];

  const suggestions: PlaceSuggestion[] = [];
  for (const item of payload as RawPlace[]) {
    const latitude = Number(item.lat);
    const longitude = Number(item.lon);
    if (
      typeof item.display_name !== "string" ||
      typeof item.place_id !== "number" ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      continue;
    }
    suggestions.push({
      id: item.place_id,
      label: item.display_name,
      latitude,
      longitude,
    });
  }
  return suggestions;
}

/**
 * Searches places for a free-text query. Returns [] on upstream errors —
 * the address field always remains usable as plain text (§58 error states).
 */
export async function searchPlaces(
  query: string,
  fetchImpl: FetchLike = fetch,
): Promise<PlaceSuggestion[]> {
  const key = normalize(query);
  if (key.length < 3) return [];

  const cached = cache.get(key);
  if (cached && Date.now() - cached.at <= CACHE_TTL_MS) return cached.results;

  try {
    const url = new URL(NOMINATIM_URL);
    url.searchParams.set("q", query.trim());
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "5");
    url.searchParams.set("addressdetails", "0");

    const response = await fetchImpl(url.toString(), {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return [];

    const results = parseResults(await response.json().catch(() => null));
    pruneCache();
    cache.set(key, { at: Date.now(), results });
    return results;
  } catch {
    // Timeout/network failure — degrade to "no suggestions" (§58).
    return [];
  }
}
