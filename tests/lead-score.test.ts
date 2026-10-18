import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEIGHTS,
  scoreLead,
  type LeadScoreWeightsOverride,
  type ScoreableContact,
  type ScoreableLead,
} from "../src/services/lead-score.service";
import { env } from "../src/config/env";

/**
 * Scoring fixture table (IMPLEMENTATION_PLAN step 23, FEATURES §18):
 * input → expected score. `scoreLead` is pure, so every row runs with no
 * database and no model — the same input must always produce the same output,
 * and the score comes from backend rules (LEAD_SCORE_* config), never from
 * arbitrary AI output (§18).
 */

const EMPTY_LEAD: ScoreableLead = {
  serviceId: null,
  urgency: null,
  location: null,
  postcode: null,
  budget: null,
  preferredDate: null,
  preferredTime: null,
  customerMessage: null,
};

const NO_CONTACT: ScoreableContact = { phone: null, email: null };

interface Fixture {
  name: string;
  lead?: Partial<ScoreableLead>;
  contact?: Partial<ScoreableContact>;
  areaCovered?: boolean | null;
  weights?: LeadScoreWeightsOverride;
  /** Input → expected score — the point of the fixture table. */
  expected: number;
  /** Exact factor keys expected in the breakdown, in order. */
  factors?: string[];
}

const LONG_MESSAGE = "My boiler is leaking and I need it fixed soon please.";
const SHORT_MESSAGE = "Boiler broken";

const FIXTURES: Fixture[] = [
  {
    name: "an empty lead scores 0",
    expected: 0,
    factors: [],
  },
  {
    name: "contact completeness: phone only",
    contact: { phone: "07700 900222" },
    expected: DEFAULT_WEIGHTS.phone,
    factors: ["phone"],
  },
  {
    name: "contact completeness: email only",
    contact: { email: "sam@example.com" },
    expected: DEFAULT_WEIGHTS.email,
    factors: ["email"],
  },
  {
    name: "contact completeness: phone and email",
    contact: { phone: "07700 900222", email: "sam@example.com" },
    expected: DEFAULT_WEIGHTS.phone + DEFAULT_WEIGHTS.email,
    factors: ["phone", "email"],
  },
  {
    name: "service match",
    lead: { serviceId: "service-1" },
    expected: DEFAULT_WEIGHTS.service,
    factors: ["service"],
  },
  {
    name: "service area covered",
    areaCovered: true,
    expected: DEFAULT_WEIGHTS.area,
    factors: ["area"],
  },
  {
    name: "a location outside the service area earns no area points",
    lead: { location: "Edinburgh", postcode: "EH1 1AA" },
    areaCovered: false,
    expected: 0,
    factors: [],
  },
  {
    name: "an unknown location never assumes coverage",
    areaCovered: null,
    expected: 0,
    factors: [],
  },
  {
    name: "urgency HIGH",
    lead: { urgency: "HIGH" },
    expected: DEFAULT_WEIGHTS.urgency.HIGH,
    factors: ["urgency"],
  },
  {
    name: "urgency MEDIUM",
    lead: { urgency: "MEDIUM" },
    expected: DEFAULT_WEIGHTS.urgency.MEDIUM,
    factors: ["urgency"],
  },
  {
    name: "urgency LOW",
    lead: { urgency: "LOW" },
    expected: DEFAULT_WEIGHTS.urgency.LOW,
    factors: ["urgency"],
  },
  {
    name: "budget given",
    lead: { budget: 250 },
    expected: DEFAULT_WEIGHTS.budget,
    factors: ["budget"],
  },
  {
    name: "appointment intent via a preferred date",
    lead: { preferredDate: new Date("2026-11-01T09:00:00Z") },
    expected: DEFAULT_WEIGHTS.appointment,
    factors: ["appointment"],
  },
  {
    name: "appointment intent via a preferred time only",
    lead: { preferredTime: "morning" },
    expected: DEFAULT_WEIGHTS.appointment,
    factors: ["appointment"],
  },
  {
    name: "required information: a substantive message",
    lead: { customerMessage: LONG_MESSAGE },
    expected: DEFAULT_WEIGHTS.information,
    factors: ["information"],
  },
  {
    name: "a throwaway message does not count as required information",
    lead: { customerMessage: SHORT_MESSAGE },
    expected: 0,
    factors: [],
  },
  {
    name: "a complete, covered lead scores the full 100",
    lead: {
      serviceId: "service-1",
      urgency: "HIGH",
      location: "Reading",
      postcode: "RG1 4AB",
      budget: 500,
      preferredDate: new Date("2026-11-01T09:00:00Z"),
      customerMessage: LONG_MESSAGE,
    },
    contact: { phone: "07700 900222", email: "sam@example.com" },
    areaCovered: true,
    expected: 100,
    factors: [
      "service",
      "area",
      "urgency",
      "appointment",
      "information",
      "budget",
      "phone",
      "email",
    ],
  },
  {
    name: "configured weights drive the score (service raised)",
    lead: { serviceId: "service-1" },
    weights: { service: 30 },
    expected: 30,
    factors: ["service"],
  },
  {
    name: "overriding one urgency tier leaves the others configured",
    lead: { urgency: "HIGH" },
    weights: { urgency: { HIGH: 25 } },
    expected: 25,
    factors: ["urgency"],
  },
  {
    name: "a zero weight drops the factor from the breakdown",
    contact: { phone: "07700 900222" },
    weights: { phone: 0 },
    expected: 0,
    factors: [],
  },
  {
    name: "the total is capped at LEAD_SCORE_MAX",
    lead: { serviceId: "service-1" },
    areaCovered: true,
    weights: { service: 90, area: 90 },
    expected: env.LEAD_SCORE_MAX,
    factors: ["service", "area"],
  },
];

describe("lead scoring fixture table (§18, step 23)", () => {
  it.each(FIXTURES)("$name", (fixture) => {
    const result = scoreLead(
      { ...EMPTY_LEAD, ...fixture.lead },
      { ...NO_CONTACT, ...fixture.contact },
      { areaCovered: fixture.areaCovered ?? null, weights: fixture.weights },
    );

    expect(result.score).toBe(fixture.expected);
    // Always in range — never a negative or out-of-bound score (§18).
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(env.LEAD_SCORE_MAX);
    if (fixture.factors) {
      expect(result.factors.map((factor) => factor.key)).toEqual(
        fixture.factors,
      );
    }
  });

  it("is deterministic — the same input always scores the same", () => {
    const lead: ScoreableLead = {
      ...EMPTY_LEAD,
      serviceId: "service-1",
      urgency: "MEDIUM",
      postcode: "RG1 4AB",
      budget: 300,
    };
    const contact: ScoreableContact = { phone: "07700 900222", email: null };

    const first = scoreLead(lead, contact, { areaCovered: true });
    const second = scoreLead(lead, contact, { areaCovered: true });

    expect(second).toEqual(first);
    expect(first.score).toBe(
      DEFAULT_WEIGHTS.service +
        DEFAULT_WEIGHTS.area +
        DEFAULT_WEIGHTS.urgency.MEDIUM +
        DEFAULT_WEIGHTS.budget +
        DEFAULT_WEIGHTS.phone,
    );
  });

  it("takes its default weights from backend config (env)", () => {
    expect(DEFAULT_WEIGHTS.service).toBe(env.LEAD_SCORE_SERVICE);
    expect(DEFAULT_WEIGHTS.area).toBe(env.LEAD_SCORE_AREA);
    expect(DEFAULT_WEIGHTS.urgency.HIGH).toBe(env.LEAD_SCORE_URGENCY_HIGH);
    expect(DEFAULT_WEIGHTS.urgency.MEDIUM).toBe(env.LEAD_SCORE_URGENCY_MEDIUM);
    expect(DEFAULT_WEIGHTS.urgency.LOW).toBe(env.LEAD_SCORE_URGENCY_LOW);
    expect(DEFAULT_WEIGHTS.appointment).toBe(env.LEAD_SCORE_APPOINTMENT);
    expect(DEFAULT_WEIGHTS.information).toBe(env.LEAD_SCORE_INFORMATION);
    expect(DEFAULT_WEIGHTS.budget).toBe(env.LEAD_SCORE_BUDGET);
    expect(DEFAULT_WEIGHTS.phone).toBe(env.LEAD_SCORE_PHONE);
    expect(DEFAULT_WEIGHTS.email).toBe(env.LEAD_SCORE_EMAIL);
  });
});