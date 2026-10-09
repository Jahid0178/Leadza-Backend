import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { geocoderCache, searchPlaces } from "../src/services/geocoder.service";

const app = createApp();

/** Nominatim jsonv2 payload fragment (shape per /search docs). */
const nominatimPayload = [
  {
    place_id: 11223344,
    lat: "51.4543",
    lon: "-0.9781",
    display_name: "Reading, United Kingdom",
    category: "place",
  },
  { place_id: 99, lat: "not-a-number", lon: "-0.1", display_name: "Broken row" },
  { place_id: 98, lat: "52.1", lon: "-1.2", display_name: 42 },
];

function stubFetch(impl: (url: string) => Promise<Response>) {
  let calls = 0;
  const fetchImpl = (input: string) => {
    calls += 1;
    return impl(input);
  };
  return {
    fetchImpl: fetchImpl as typeof fetch,
    get calls() {
      return calls;
    },
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response;
}

describe("searchPlaces (unit)", () => {
  it("maps valid Nominatim results and skips malformed rows", async () => {
    geocoderCache().clear();
    const stub = stubFetch(async () => jsonResponse(nominatimPayload));

    const places = await searchPlaces("Reading town centre", stub.fetchImpl);

    expect(places).toEqual([
      {
        id: 11223344,
        label: "Reading, United Kingdom",
        latitude: 51.4543,
        longitude: -0.9781,
      },
    ]);
    expect(stub.calls).toBe(1);
    expect(stub.fetchImpl).toBeDefined();
  });

  it("requests the documented search endpoint with jsonv2 + limit", async () => {
    geocoderCache().clear();
    let requestedUrl = "";
    const stub = stubFetch(async (url) => {
      requestedUrl = url;
      return jsonResponse([]);
    });

    await searchPlaces("RG1 2AB", stub.fetchImpl);

    const url = new URL(requestedUrl);
    expect(url.origin + url.pathname).toBe("https://nominatim.openstreetmap.org/search");
    expect(url.searchParams.get("q")).toBe("RG1 2AB");
    expect(url.searchParams.get("format")).toBe("jsonv2");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("serves repeat queries from cache without a second upstream call", async () => {
    geocoderCache().clear();
    const stub = stubFetch(async () => jsonResponse(nominatimPayload));

    const first = await searchPlaces("Cached Place", stub.fetchImpl);
    const second = await searchPlaces("  cached   place ", stub.fetchImpl);

    expect(second).toEqual(first);
    expect(stub.calls).toBe(1); // normalized query → one upstream hit
  });

  it("skips the upstream entirely for queries under 3 characters", async () => {
    const stub = stubFetch(async () => jsonResponse([]));
    expect(await searchPlaces("ab", stub.fetchImpl)).toEqual([]);
    expect(stub.calls).toBe(0);
  });

  it("degrades to an empty list on upstream failure (§58)", async () => {
    geocoderCache().clear();
    const failing = stubFetch(async () => {
      throw new Error("network down");
    });
    expect(await searchPlaces("Anywhereville", failing.fetchImpl)).toEqual([]);

    const serverError = stubFetch(async () => jsonResponse({}, false));
    expect(await searchPlaces("Anywhereville 2", serverError.fetchImpl)).toEqual([]);

    const garbage = stubFetch(async () => jsonResponse("not an array"));
    expect(await searchPlaces("Anywhereville 3", garbage.fetchImpl)).toEqual([]);
  });
});

describe("GET /api/v1/geocode/search (http)", () => {
  it("requires authentication (§49 — integrations stay behind auth)", async () => {
    const res = await request(app).get("/api/v1/geocode/search?q=Reading");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a too-short or missing query before any upstream call", async () => {
    const stamp = Date.now();
    const register = await request(app).post("/api/v1/auth/register").send({
      name: "Geocode Tester",
      email: `geocode-${stamp}@example.com`,
      password: "s3cure-pass-1",
    });
    expect(register.status).toBe(201);
    const header = register.headers["set-cookie"];
    const cookies = Array.isArray(header) ? header : [header];
    const cookie = cookies.find((c) => c.startsWith("authjs.session-token="))?.split(";")[0];
    expect(cookie).toBeDefined();

    const short = await request(app)
      .get("/api/v1/geocode/search")
      .query({ q: "ab" })
      .set("Cookie", cookie!);
    expect(short.status).toBe(400);
    expect(short.body.error.code).toBe("VALIDATION_ERROR");

    const missing = await request(app)
      .get("/api/v1/geocode/search")
      .set("Cookie", cookie!);
    expect(missing.status).toBe(400);
  });

  // The happy path calls the live public Nominatim instance (rate-limited to
  // ~1 req/s), so it's covered by unit tests above and browser verification
  // rather than a network-dependent suite assertion.
});
