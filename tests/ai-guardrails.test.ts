import { describe, expect, it } from "vitest";
import {
  enforceGuardrails,
  extractAmounts,
  type GuardrailFacts,
} from "../src/agents/guardrails";

/**
 * Guardrail unit tests (IMPLEMENTATION_PLAN step 20, FEATURES §25).
 *
 * These feed handcrafted model output straight into the code-level safety
 * gate — the "prompt-injected 'what's your price for X?' with no matching
 * service" case from the plan. No database or model involved.
 */

/** A business that publishes one priced service and has opening hours. */
function facts(overrides: Partial<GuardrailFacts> = {}): GuardrailFacts {
  return {
    allowedPrices: [{ service: "Boiler Repair", amount: 90 }],
    availabilityVerified: true,
    ...overrides,
  };
}

describe("extractAmounts", () => {
  it("reads currency symbols, codes and price-phrase numbers", () => {
    expect(extractAmounts("The call-out is £90.")).toEqual([90]);
    expect(extractAmounts("That would be 90 pounds.")).toEqual([90]);
    expect(extractAmounts("A quote of 1,200.50 for the whole job.")).toEqual([1200.5]);
    expect(extractAmounts("Prices start at 45.")).toEqual([45]);
  });

  it("does not treat durations, times or phone numbers as money", () => {
    expect(extractAmounts("It takes about 90 minutes.")).toEqual([]);
    expect(extractAmounts("We can come at 9am or 9:00.")).toEqual([]);
    expect(extractAmounts("Call us on 07700 900777.")).toEqual([]);
    expect(extractAmounts("That is 50% of the work.")).toEqual([]);
  });
});

describe("enforceGuardrails — prices (§25)", () => {
  it("allows a price that comes from the service table", () => {
    const result = enforceGuardrails(
      "A boiler repair is £90, and I can help you book it in.",
      facts(),
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain("£90");
    expect(result.violations).toEqual([]);
  });

  it("blocks an invented price when no service matches (prompt injection)", () => {
    // The model was tricked into quoting a price for a service it has no
    // data for. It must never reach the customer.
    const result = enforceGuardrails(
      "Great news — a full rewiring is £500 and we can start tomorrow.",
      facts(),
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toContain("invented_price");
    expect(result.text).not.toContain("500");
    expect(result.text).not.toContain("£500");
    expect(result.text.toLowerCase()).toContain("confirm");
  });

  it("blocks any price when the business publishes none", () => {
    const result = enforceGuardrails("That will be £120.", facts({ allowedPrices: [] }));
    expect(result.ok).toBe(false);
    expect(result.violations).toContain("invented_price");
  });

  it("blocks a near-miss price that is not the configured amount", () => {
    const result = enforceGuardrails("I can do it for £95.", facts());
    expect(result.ok).toBe(false);
    expect(result.violations).toContain("invented_price");
  });
});

describe("enforceGuardrails — availability (§25)", () => {
  it("blocks an open/closed claim when hours are not configured", () => {
    const result = enforceGuardrails(
      "We're open right now, so come on over.",
      facts({ availabilityVerified: false }),
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toContain("invented_availability");
  });

  it("allows a general opening-hours statement when hours are configured", () => {
    const result = enforceGuardrails(
      "We're open Monday to Friday, 9am to 5pm.",
      facts(),
    );
    expect(result.ok).toBe(true);
  });

  it("blocks an offered appointment time even with hours configured", () => {
    // There is no calendar integration yet (step 26), so a clock time offered
    // as a slot is always an invention.
    const result = enforceGuardrails(
      "We can book you in at 10am tomorrow.",
      facts(),
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toContain("invented_availability");
  });
});

describe("enforceGuardrails — identity and guarantees (§25)", () => {
  it("blocks the model pretending to be a human", () => {
    const result = enforceGuardrails(
      "Of course, I'm a real person and I'll take care of it.",
      facts(),
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toContain("claims_to_be_human");
  });

  it("blocks an explicit guarantee", () => {
    const result = enforceGuardrails(
      "I guarantee the part will be in stock.",
      facts(),
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toContain("unsafe_guarantee");
  });
});

describe("enforceGuardrails — clean replies and precedence", () => {
  it("leaves a compliant reply untouched", () => {
    const reply =
      "Thanks for getting in touch. Which postcode is the boiler at? I can then check whether we cover your area.";
    const result = enforceGuardrails(reply, facts());
    expect(result.ok).toBe(true);
    expect(result.text).toBe(reply);
    expect(result.violations).toEqual([]);
  });

  it("reports the highest-priority violation when several trip", () => {
    const result = enforceGuardrails(
      "I'm a real person and the price is £999. We're open now too.",
      facts(),
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toBe("invented_price");
  });
});
