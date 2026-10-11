import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma";
import { checkServiceArea } from "../src/services/servicearea.service";
import { isOpenAt } from "../src/services/businesshour.service";

/**
 * Unit tests for the Phase B internal helpers (IMPLEMENTATION_PLAN steps
 * 10–11): checkServiceArea() and isOpenAt(). These back the AI tools (step
 * 21) and booking (step 27), so the §25 rule is asserted here: neither
 * helper ever invents coverage or availability that was not configured.
 */

const stamp = Date.now();
let businessId: string;

beforeAll(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Helper Test Plumbing ${stamp}`,
      latitude: 51.4543, // Reading
      longitude: -0.9724,
    },
  });
  businessId = business.id;

  await prisma.serviceArea.createMany({
    data: [
      { businessId, value: "RG1", label: "Reading town centre" },
      { businessId, value: "Wokingham", label: null },
      { businessId, value: "RG7", radiusKm: 10 },
    ],
  });

  await prisma.businessHour.createMany({
    data: [
      { businessId, weekday: "MONDAY", startTime: "08:00", endTime: "12:00", orderIndex: 0 },
      { businessId, weekday: "MONDAY", startTime: "13:00", endTime: "18:00", orderIndex: 1 },
      { businessId, weekday: "TUESDAY", startTime: "09:00", endTime: "17:00", orderIndex: 0, emergency: true },
      { businessId, weekday: "WEDNESDAY", startTime: "00:00", endTime: "00:00", orderIndex: 0, closed: true },
      { businessId, weekday: "FRIDAY", startTime: "20:00", endTime: "04:00", orderIndex: 0 },
    ],
  });
});

afterAll(async () => {
  await prisma.business.deleteMany({ where: { name: `Helper Test Plumbing ${stamp}` } });
});

describe("checkServiceArea (§11, step 10)", () => {
  it("matches a full postcode against a stored outward code", async () => {
    const result = await checkServiceArea(businessId, { postcode: "RG1 4AB" });
    expect(result.inArea).toBe(true);
    expect(result.matchedOn).toBe("postcode");
  });

  it("is case- and space-insensitive on the postcode", async () => {
    const result = await checkServiceArea(businessId, { postcode: " rg14ab " });
    expect(result.inArea).toBe(true);
    expect(result.matchedOn).toBe("postcode");
  });

  it("does not match a longer outward code (RG1 vs RG12)", async () => {
    const result = await checkServiceArea(businessId, { postcode: "RG12 3DE" });
    expect(result.inArea).toBe(false);
    expect(result.matchedAreaId).toBeNull();
  });

  it("matches a place name against value or label", async () => {
    const byValue = await checkServiceArea(businessId, { place: "wokingham" });
    expect(byValue.inArea).toBe(true);
    expect(byValue.matchedOn).toBe("place");

    const byLabel = await checkServiceArea(businessId, { place: "Reading Town Centre" });
    expect(byLabel.inArea).toBe(true);
  });

  it("matches by radius when coordinates are supplied and no name matches", async () => {
    // ~2 km from the business coordinates → inside the RG7 10 km radius.
    const result = await checkServiceArea(businessId, {
      place: "Unknown Village",
      latitude: 51.47,
      longitude: -0.95,
    });
    expect(result.inArea).toBe(true);
    expect(result.matchedOn).toBe("radius");
  });

  it("never invents coverage for an uncovered location (§25)", async () => {
    const result = await checkServiceArea(businessId, {
      postcode: "SW1A 1AA",
      place: "London",
      latitude: 51.5,
      longitude: -0.12,
    });
    expect(result).toEqual({ inArea: false, matchedAreaId: null, matchedOn: null });
  });

  it("returns no match when the business has no areas configured", async () => {
    const empty = await prisma.business.create({
      data: { name: `Empty Areas ${stamp}` },
    });
    const result = await checkServiceArea(empty.id, { postcode: "RG1 4AB" });
    expect(result.inArea).toBe(false);
    await prisma.business.delete({ where: { id: empty.id } });
  });
});

describe("isOpenAt (§12, step 11)", () => {
  // Build a Date that lands on a given weekday/time in Europe/London for the
  // week of Monday 5 Jan 2026 (GMT, so UTC arithmetic is exact in January).
  const at = (dayIndex: number, time: string) => {
    const [h, m] = time.split(":").map(Number);
    const monday = Date.UTC(2026, 0, 5);
    return new Date(monday + dayIndex * 86_400_000 + (h ?? 0) * 3_600_000 + (m ?? 0) * 60_000);
  };

  it("is open inside the first Monday range", async () => {
    const result = await isOpenAt(businessId, at(0, "10:00"));
    expect(result.open).toBe(true);
    expect(result.emergency).toBe(false);
    expect(result.weekday).toBe("MONDAY");
  });

  it("is closed between ranges and at the closing boundary", async () => {
    expect((await isOpenAt(businessId, at(0, "12:30"))).open).toBe(false);
    expect((await isOpenAt(businessId, at(0, "18:00"))).open).toBe(false);
    expect((await isOpenAt(businessId, at(0, "07:59"))).open).toBe(false);
  });

  it("reports the emergency flag on emergency-only ranges", async () => {
    const result = await isOpenAt(businessId, at(1, "11:00"));
    expect(result.open).toBe(true);
    expect(result.emergency).toBe(true);
  });

  it("treats a closed day as closed regardless of times", async () => {
    const result = await isOpenAt(businessId, at(2, "10:00"));
    expect(result.open).toBe(false);
    expect(result.weekday).toBe("WEDNESDAY");
  });

  it("covers an overnight range on both sides of midnight", async () => {
    expect((await isOpenAt(businessId, at(4, "22:00"))).open).toBe(true); // Friday 22:00
    expect((await isOpenAt(businessId, at(5, "02:00"))).open).toBe(true); // Saturday 02:00 — Friday's range spills over
    expect((await isOpenAt(businessId, at(4, "12:00"))).open).toBe(false); // Friday midday
    expect((await isOpenAt(businessId, at(5, "05:00"))).open).toBe(false); // past the 04:00 end
  });

  it("is closed for a business with no hours configured (§25)", async () => {
    const empty = await prisma.business.create({
      data: { name: `No Hours ${stamp}` },
    });
    const result = await isOpenAt(empty.id, at(0, "10:00"));
    expect(result.open).toBe(false);
    expect(result.emergency).toBe(false);
    await prisma.business.delete({ where: { id: empty.id } });
  });
});
