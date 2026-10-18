import type { LeadUrgency } from "../../generated/prisma/client";
import { env } from "../config/env";

/**
 * Rule-based lead scoring (FEATURES §18, IMPLEMENTATION_PLAN step 23).
 *
 * Deterministic and inspectable: the same lead always scores the same, and
 * the breakdown explains why. Nothing here is model output — the AI may
 * *request* a score (calculateLeadScore tool), never invent one (§18).
 *
 * The rules are configurable in the backend: every weight comes from the
 * LEAD_SCORE_* variables validated in `config/env.ts` (§18 "configurable in
 * the backend"). Service-area coverage is *not* decided here — the scorer
 * stays pure and receives `context.areaCovered` from its caller, which
 * computes it with `checkServiceArea()` against the business's own
 * configured areas. Points for the area factor are awarded only for `true`,
 * so coverage is never assumed (§25) and an unknown or out-of-area lead
 * simply scores nothing for that factor.
 *
 * Factors (§18): service match, service area, urgency, appointment intent,
 * required information, budget, contact information.
 */

/** The weight of each factor, as configured on the backend. */
export interface LeadScoreWeights {
  /** The lead named one of the business's services (service match). */
  service: number;
  /** The lead's location falls inside the configured service area. */
  area: number;
  urgency: Record<LeadUrgency, number>;
  /** A preferred date and/or time was given (appointment intent). */
  appointment: number;
  /** A substantive customer message was left (required information). */
  information: number;
  budget: number;
  phone: number;
  email: number;
}

/** Partial overrides on top of `DEFAULT_WEIGHTS`. */
export interface LeadScoreWeightsOverride
  extends Partial<Omit<LeadScoreWeights, "urgency">>
{
  /** Override just the urgency tiers if you like (HIGH/MEDIUM/LOW). */
  urgency?: Partial<LeadScoreWeights["urgency"]>;
}

/** Weights from backend config (env.ts); defaults sum to LEAD_SCORE_MAX. */
export const DEFAULT_WEIGHTS: LeadScoreWeights = {
  service: env.LEAD_SCORE_SERVICE,
  area: env.LEAD_SCORE_AREA,
  urgency: {
    HIGH: env.LEAD_SCORE_URGENCY_HIGH,
    MEDIUM: env.LEAD_SCORE_URGENCY_MEDIUM,
    LOW: env.LEAD_SCORE_URGENCY_LOW,
  },
  appointment: env.LEAD_SCORE_APPOINTMENT,
  information: env.LEAD_SCORE_INFORMATION,
  budget: env.LEAD_SCORE_BUDGET,
  phone: env.LEAD_SCORE_PHONE,
  email: env.LEAD_SCORE_EMAIL,
};

/** The lead fields scoring reads (a subset of the row). */
export interface ScoreableLead {
  serviceId: string | null;
  urgency: LeadUrgency | null;
  location: string | null;
  postcode: string | null;
  budget: number | null;
  preferredDate: Date | null;
  preferredTime: string | null;
  customerMessage: string | null;
}

/** Customer contact completeness, used for the reachability factor. */
export interface ScoreableContact {
  phone: string | null;
  email: string | null;
}

/** Inputs the scorer cannot see on the lead row itself. */
export interface LeadScoreContext {
  /**
   * Whether the lead's location is covered by the business's service areas
   * (as decided by `checkServiceArea()`). `null` = no location known yet.
   */
  areaCovered?: boolean | null;
  /** Override the configured weights (tests; per-business rules later). */
  weights?: LeadScoreWeightsOverride;
}

export interface LeadScoreFactor {
  /** Short machine label, e.g. "service". */
  key: string;
  /** Points contributed. */
  points: number;
}

export interface LeadScoreResult {
  /** 0..LEAD_SCORE_MAX (100 by default). */
  score: number;
  factors: LeadScoreFactor[];
}

/** Message length that counts as a substantive answer (required information). */
const MIN_INFORMATION_LENGTH = 20;

/** `DEFAULT_WEIGHTS` with any partial overrides applied. */
function resolveWeights(
  overrides?: LeadScoreWeightsOverride,
): LeadScoreWeights {
  if (!overrides) return DEFAULT_WEIGHTS;
  const { urgency, ...rest } = overrides;
  return {
    ...DEFAULT_WEIGHTS,
    ...rest,
    urgency: { ...DEFAULT_WEIGHTS.urgency, ...urgency },
  };
}

/** Score a lead from its structured fields. Pure — no database access. */
export function scoreLead(
  lead: ScoreableLead,
  contact: ScoreableContact,
  context: LeadScoreContext = {},
): LeadScoreResult {
  const weights = resolveWeights(context.weights);
  const factors: LeadScoreFactor[] = [];
  const add = (key: string, points: number) => {
    if (points > 0) factors.push({ key, points });
  };

  add("service", lead.serviceId ? weights.service : 0);
  add("area", context.areaCovered ? weights.area : 0);
  add("urgency", lead.urgency ? weights.urgency[lead.urgency] : 0);
  add(
    "appointment",
    lead.preferredDate || lead.preferredTime ? weights.appointment : 0,
  );
  add(
    "information",
    (lead.customerMessage?.trim().length ?? 0) >= MIN_INFORMATION_LENGTH
      ? weights.information
      : 0,
  );
  add("budget", lead.budget !== null ? weights.budget : 0);
  add("phone", contact.phone ? weights.phone : 0);
  add("email", contact.email ? weights.email : 0);

  const score = Math.min(
    env.LEAD_SCORE_MAX,
    factors.reduce((total, factor) => total + factor.points, 0),
  );

  return { score, factors };
}