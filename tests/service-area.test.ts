import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma";
import { checkServiceArea } from "../src/services/servicearea.service";

/**
 * Service-area matching (FEATURES §11, IMPLEMENTATION_PLAN step 10).
 *
 * The bug these pin down: a business added a Savar area and the AI told the
 * customer Savar was not covered, because matching was exact string equality
 * only. Matching is now token-based, so an area still has to be genuinely
 * present in what the customer said — while generic filler words ("near the bus
 * stand") and generic area words ("service area") no longer defeat it.
 */

const stamp = Date.now();

// A business that stores a plain compound place name.
let plainBusinessId: string;
let plainSavarAreaId: string;

// The real-world shape: a Bangladesh postcode value with a place label —
// value "1340", label "Savar Service Area".
let labelledBusinessId: string;
let labelledSavarAreaId: string;

beforeAll(async () => {
  const plain = await prisma.business.create({
    data: {
      name: `Service Area Plain ${stamp}`,
      type: "Plumber",
      currency: "BDT",
      locale: "en-GB",
    },
  });
  plainBusinessId = plain.id;
  const savar = await prisma.serviceArea.create({
    data: { businessId: plainBusinessId, value: "Savar Dhaka town" },
  });
  plainSavarAreaId = savar.id;
  await prisma.serviceArea.create({ data: { businessId: plainBusinessId, value: "RG1", label: "Reading" } });
  await prisma.serviceArea.create({ data: { businessId: plainBusinessId, value: "Bath" } });

  const labelled = await prisma.business.create({
    data: {
      name: `Service Area Labelled ${stamp}`,
      type: "Plumber",
      currency: "BDT",
      locale: "en-GB",
    },
  });
  labelledBusinessId = labelled.id;
  const labelledSavar = await prisma.serviceArea.create({
    data: { businessId: labelledBusinessId, value: "1340", label: "Savar Service Area" },
  });
  labelledSavarAreaId = labelledSavar.id;
}, 60000);

afterAll(async () => {
  await prisma.business.deleteMany({
    where: { id: { in: [plainBusinessId, labelledBusinessId] } },
  });
});

describe("checkServiceArea place matching", () => {
  it("matches a bare town against a compound stored area", async () => {
    const match = await checkServiceArea(plainBusinessId, { place: "Savar" });
    expect(match).toEqual({
      inArea: true,
      matchedAreaId: plainSavarAreaId,
      matchedOn: "place",
    });
  });

  it("matches when the customer adds filler words", async () => {
    const match = await checkServiceArea(plainBusinessId, {
      place: "Savar, near the bus stand",
    });
    expect(match.inArea).toBe(true);
    expect(match.matchedAreaId).toBe(plainSavarAreaId);
  });

  it("ignores case and surrounding whitespace", async () => {
    const match = await checkServiceArea(plainBusinessId, { place: "  sAvAr " });
    expect(match.inArea).toBe(true);
  });

  it("matches a stored label, not just its postcode value", async () => {
    const match = await checkServiceArea(labelledBusinessId, { place: "Savar" });
    expect(match).toEqual({
      inArea: true,
      matchedAreaId: labelledSavarAreaId,
      matchedOn: "place",
    });
  });

  it("matches the labelled area through filler words too", async () => {
    const match = await checkServiceArea(labelledBusinessId, {
      place: "I live in Savar",
    });
    expect(match.inArea).toBe(true);
    expect(match.matchedAreaId).toBe(labelledSavarAreaId);
  });

  it("still resolves postcodes exactly", async () => {
    const match = await checkServiceArea(plainBusinessId, { postcode: "RG1 4AB" });
    expect(match.inArea).toBe(true);
    expect(match.matchedOn).toBe("postcode");
  });

  it("does not match an unrelated place", async () => {
    const match = await checkServiceArea(plainBusinessId, { place: "Edinburgh" });
    expect(match.inArea).toBe(false);
  });

  it("does not match a place that only shares a partial word", async () => {
    // "Bathgate" must not match the stored "Bath" just because it starts the
    // same — tokens are compared whole.
    const match = await checkServiceArea(plainBusinessId, { place: "Bathgate" });
    expect(match.inArea).toBe(false);
  });

  it("does not match a query made only of generic area words", async () => {
    // "service area" describes what the row is, not where it is.
    const match = await checkServiceArea(labelledBusinessId, {
      place: "service area",
    });
    expect(match.inArea).toBe(false);
  });
});
