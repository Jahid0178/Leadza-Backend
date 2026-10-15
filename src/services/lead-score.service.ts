import type { LeadUrgency } from "../../generated/prisma/client";

/**
 * Rule-based lead scoring (FEATURES §18, IMPLEMENTATION_PLAN step 21 → 23).
 *
 * Deterministic and inspectable: the same lead always scores the same, and the
 * breakdown explains why. Nothing here is model output — the AI may *request*
 * a score (calculateLeadScore tool), never invent one (§18).
 *
 * The weights below are a first pass; step 23 promotes them to business-
 * configurable values and may adjust the bounds. Keeping them in one table
 * makes that migration additive.
 */

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

export interface LeadScoreFactor {
  /** Short machine label, e.g. "service". */
  key: string;
  /** Points contributed. */
  points: number;
}

export interface LeadScoreResult {
  /** 0-100. */
  score: number;
  factors: LeadScoreFactor[];
}

const URGENCY_POINTS: Record<LeadUrgency, number> = {
  HIGH: 15,
  MEDIUM: 8,
  LOW: 4,
};

/** Score a lead from its structured fields. Pure — no database access. */
export function scoreLead(
  lead: ScoreableLead,
  contact: ScoreableContact,
): LeadScoreResult {
  const factors: LeadScoreFactor[] = [];
  const add = (key: string, points: number) => {
    if (points > 0) factors.push({ key, points });
  };

  add("service", lead.serviceId ? 20 : 0);
  add("urgency", lead.urgency ? URGENCY_POINTS[lead.urgency] : 0);
  add("location", lead.location || lead.postcode ? 15 : 0);
  add("budget", lead.budget !== null ? 15 : 0);
  add("appointment", lead.preferredDate || lead.preferredTime ? 15 : 0);
  add("phone", contact.phone ? 10 : 0);
  add("email", contact.email ? 5 : 0);
  add("message", (lead.customerMessage?.trim().length ?? 0) >= 20 ? 5 : 0);

  const score = Math.min(
    100,
    factors.reduce((total, factor) => total + factor.points, 0),
  );

  return { score, factors };
}
