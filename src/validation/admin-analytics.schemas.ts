import { z } from "zod";
import {
  leadSourceSchema,
  leadStatusSchema,
} from "./lead.schemas";

/** The event kinds the activity feed can be narrowed by (schema.prisma). */
export const ANALYTICS_EVENT_TYPES = [
  "BUSINESS_REGISTERED",
  "LEAD_STATUS_CHANGED",
  "CONVERSATION_ESCALATED",
  "AI_RUN_FAILED",
  "CHANNEL_INTEGRATION_FAILED",
  "CHANNEL_INTEGRATION_RECOVERED",
] as const;

/**
 * Validation + response shapes for the platform analytics endpoints
 * (FEATURES §51, the "Admin analytics" build). Kept beside admin.schemas.ts:
 * cross-tenant by design, validation runs after the router-wide
 * `requireAuth, requirePlatformAdmin` gate (§14).
 *
 * ## Window rule (applied identically by every endpoint)
 * Dates are UTC calendar days. The reporting window is
 * `[from 00:00:00 UTC, to + 1 day 00:00:00 UTC)` — i.e. **`from` is
 * inclusive, `to` is inclusive as a calendar day** (its exclusive end bound
 * is reported as `window.endExclusive` on every response). Omitting both
 * fields defaults to the last 30 days ending today, so links stay clean.
 * The maximum window is 366 days. Comparisons apply the same rule to the
 * immediately preceding, equally long window.
 *
 * The reporting timezone is UTC (the platform's own convention — admin pages
 * render with PLATFORM_REGIONAL); per-business drill-downs keep each
 * business's IANA timezone.
 */

/** Longest window the endpoints accept — bounds every aggregate query. */
export const MAX_WINDOW_DAYS = 366;

/**
 * Documented detection rules for the activity feed (spec §5): these are
 * platform-defined rules with fixed parameters — the API returns the rule's
 * parameters alongside any hit so the dashboard labels them as rules, not
 * as established facts.
 */
/** A day is a spike when its lead count ≥ SPIKE_FACTOR × trailing average. */
export const SPIKE_FACTOR = 3;
/** The trailing window in days the spike rule compares against. */
export const SPIKE_TRAILING_DAYS = 7;
/** An ACTIVE business with no recorded activity this many days is "quiet". */
export const NO_ACTIVITY_DAYS = 14;

/** YYYY-MM-DD, validated as a real calendar date. */
const utcDay = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD date format.")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number) as [number, number, number];
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }, "That date does not exist.")
  .transform((value) => `${value}T00:00:00.000Z`);

/**
 * The reporting window shared by every analytics endpoint: optional
 * from/to days (defaults + sanity limits below) and the derived instants.
 */
const windowQuery = z
  .object({
    from: utcDay.optional(),
    to: utcDay.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.from && value.to) {
      if (new Date(value.from) > new Date(value.to)) {
        ctx.addIssue({
          code: "custom",
          path: ["from"],
          message: "'from' must not be after 'to'.",
        });
        return;
      }
      const spanDays =
        Math.round((new Date(value.to).getTime() - new Date(value.from).getTime()) / 86400000) + 1;
      if (spanDays > MAX_WINDOW_DAYS) {
        ctx.addIssue({
          code: "custom",
          path: ["to"],
          message: `The window may span at most ${MAX_WINDOW_DAYS} days.`,
        });
      }
    }
  });

export type AnalyticsWindowQuery = z.infer<typeof windowQuery>;

/** GET /api/v1/admin/analytics/overview — only the reporting window. */
export const adminAnalyticsOverviewQuerySchema = windowQuery;

/** Sort whitelist for the businesses usage table (§4 of the spec). */
export const ANALYTICS_BUSINESS_SORT_FIELDS = [
  "name",
  "status",
  "createdAt",
  "leads",
  "lastActivity",
] as const;

export const listAdminAnalyticsBusinessesQuerySchema = windowQuery.extend({
  /** Free-text search over the business name. */
  search: z.string().trim().max(200).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
  /** Whitelisted sort — arbitrary column names are rejected, never passed on. */
  sort: z.enum(ANALYTICS_BUSINESS_SORT_FIELDS).default("leads"),
  order: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListAdminAnalyticsBusinessesQuery = z.infer<
  typeof listAdminAnalyticsBusinessesQuerySchema
>;

export const adminAnalyticsLeadsQuerySchema = windowQuery.extend({
  businessId: z.string().trim().min(1).optional(),
  source: leadSourceSchema.optional(),
  status: leadStatusSchema.optional(),
});

export type AdminAnalyticsLeadsQuery = z.infer<
  typeof adminAnalyticsLeadsQuerySchema
>;

export const adminAnalyticsAiPerformanceQuerySchema = windowQuery.extend({
  businessId: z.string().trim().min(1).optional(),
});

export type AdminAnalyticsAiPerformanceQuery = z.infer<
  typeof adminAnalyticsAiPerformanceQuerySchema
>;

export const adminAnalyticsActivityQuerySchema = windowQuery.extend({
  /** Filter the feed by recorded event type (§45-style narrowing). */
  type: z.enum(ANALYTICS_EVENT_TYPES).optional(),
  businessId: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type AdminAnalyticsActivityQuery = z.infer<
  typeof adminAnalyticsActivityQuerySchema
>;

/* ------------------------------------------------------------------ *
 * Response shapes (agent.md §26) — aggregates only, never lead or
 * conversation contents.
 * ------------------------------------------------------------------ */

/** A windowed metric alongside the previous equivalent window. */
export interface AdminAnalyticsMetric {
  current: number;
  /** null = the previous window has no comparable data. */
  previous: number | null;
}

/** The reporting window every analytics response echoes back. */
export interface AdminAnalyticsWindowDto {
  /** Inclusive first day, YYYY-MM-DD. */
  from: string;
  /** Inclusive last day, YYYY-MM-DD. */
  to: string;
  /** The window's real end: exclusive (to + 1 day midnight). */
  endExclusive: string;
  /** The previous equivalent window's start (YYYY-MM-DD) or null. */
  previousFrom: string | null;
  previousTo: string | null;
  /** "UTC" for platform windows; a business timezone for drill-downs. */
  reportingTimezone: string;
}

/** §51 platform overview — GET /admin/analytics/overview. */
export interface AdminAnalyticsOverviewDto {
  window: AdminAnalyticsWindowDto;
  /** Registration snapshot (current state; comparisons not meaningful). */
  businesses: {
    total: number;
    active: number;
    suspended: number;
    /** New registrations inside the window, with previous-window comparison. */
    newRegistrations: AdminAnalyticsMetric;
  };
  leads: {
    /** Leads created in the window. */
    total: AdminAnalyticsMetric;
    /** Created since midnight UTC today, independent of the window. */
    today: number;
    /** Cohort leads that reached QUALIFIED or beyond (as of now). */
    qualified: AdminAnalyticsMetric;
    /** Bookings created in the window, cancelled excluded. */
    bookedAppointments: AdminAnalyticsMetric;
    /** won ÷ cohort (spam excluded) × 100 for the creation cohort, 1 decimal. */
    conversionRate: AdminAnalyticsMetric;
  };
  conversations: {
    /** Currently HUMAN_REQUESTED — snapshot, no comparison. */
    awaitingHuman: number;
    /** CONVERSATION_ESCALATED events in the window (AI + staff). */
    escalations: AdminAnalyticsMetric;
    /** AI_RUN_FAILED events in the window — never conflated with escalations. */
    aiRunFailures: AdminAnalyticsMetric;
  };
}

/** Lead analytics — GET /admin/analytics/leads. */
export interface AdminLeadAnalyticsDto {
  window: AdminAnalyticsWindowDto;
  filters: { businessId: string | null; source: string | null; status: string | null };
  /** One UTC day per bucket from `from` to `to`, zero-filled. */
  volumeByDay: Array<{ date: string; leads: number }>;
  /** Same buckets with won-per-day, for the conversion trend chart. */
  conversionTrend: Array<{ date: string; rate: number; leads: number }>;
  sources: Array<{ source: string; count: number }>;
  /** Of the window's cohort: qualifies as outcomes (as of now). */
  statusDistribution: Array<{ status: string; count: number }>;
  qualifiedVsUnqualified: {
    qualified: number;
    unqualified: number;
    spam: number;
  };
  /** Cumulative cohort funnel (§28 semantics; spam excluded from enquiries). */
  funnel: {
    enquiries: number;
    qualified: number;
    booked: number;
    won: number;
  };
  /** Bookings created in the window (cancelled excluded). */
  bookedAppointments: number;
  /** Distinct cohort leads with a qualifying booking ÷ cohort × 100 (§2). */
  leadToBookingRate: number;
  /** Busiest businesses in the window (top 10, id + name resolved). */
  topBusinesses: Array<{ businessId: string; name: string; leads: number }>;
  /** Services chosen on the cohort's enquiry (top 10; null grouped as "None"). */
  byService: Array<{ serviceId: string | null; name: string; leads: number }>;
}

/** AI agent performance — GET /admin/analytics/ai-performance. */
export interface AdminAiPerformanceDto {
  window: AdminAnalyticsWindowDto;
  filters: { businessId: string | null };
  /** Conversations with at least one AI reply, opened in the window. */
  aiHandled: AdminAnalyticsMetric;
  /** AI-handled threads with no escalation on the ledger (events + tools). */
  resolvedWithoutHuman: AdminAnalyticsMetric;
  escalations: {
    /** CONVERSATION_ESCALATED events in the window. */
    total: AdminAnalyticsMetric;
    /** Split by initiator — AI handoff tool vs staff status change. */
    byAi: number;
    byStaff: number;
    /** Currently HUMAN_REQUESTED (snapshot). */
    awaitingReview: number;
  };
  /** Minutes from the thread's first customer message to the first AI reply. */
  averageFirstResponseMinutes: number | null;
  /** First→last message on threads with measurable spans, in minutes. */
  averageHandlingMinutes: number | null;
  /** Distinct leads the AI scored or enriched (calculateLeadScore/updateLead). */
  aiQualificationLeads: AdminAnalyticsMetric;
  /** AI-origin (Booking.origin = AI) bookings created in the window. */
  aiBookedAppointments: AdminAnalyticsMetric;
  /** Leads with a qualifying booking ÷ eligible cohort × 100 (§2 example). */
  leadToBookingRate: number;
  /** AI_RUN_FAILED events in the window — never counted as escalations. */
  aiRunFailures: AdminAnalyticsMetric;
}

/** One row of the businesses usage table — GET /admin/analytics/businesses. */
export interface AdminBusinessUsageDto {
  id: string;
  name: string;
  status: string;
  /** Registration date. */
  createdAt: string;
  /** Leads created in the window. */
  leads: number;
  /** AI-handled conversations opened in the window. */
  aiConversations: number;
  /** Cohort leads at QUALIFIED or beyond (as of now). */
  qualified: number;
  /** Bookings created in the window, cancelled excluded. */
  appointments: number;
  /** Latest lead/message/booking/AI activity timestamp, or null. */
  lastActivity: string | null;
}

export interface AdminBusinessUsagePageDto {
  window: AdminAnalyticsWindowDto;
  businesses: AdminBusinessUsageDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** One merged feed/alert-entry of the activity section. */
export interface AdminAnalyticsActivityEntryDto {
  id: string;
  /** "event.escalation" | "event.ai_failure" | "event.lead_status" | "event.channel" | "business.registered" */
  kind: string;
  /** Which AnalyticsEventType a DB-backed row came from, when it did. */
  type: string | null;
  title: string;
  detail: string | null;
  businessId: string | null;
  businessName: string | null;
  createdAt: string;
}

export interface AdminAnalyticsActivityDto {
  window: AdminAnalyticsWindowDto;
  entries: AdminAnalyticsActivityEntryDto[];
  total: number;
  page: number;
  pageSize: number;
  /** Detection-rule cards kept out of the feed's pagination. */
  alerts: {
    /** Conversations currently HUMAN_REQUESTED, oldest first (max 5). */
    awaitingHuman: Array<{ conversationId: string; businessName: string; updatedAt: string }>;
    /** ACTIVE businesses with no recorded activity for NO_ACTIVITY_DAYS. */
    quietBusinesses: Array<{ id: string; name: string; lastActivity: string | null }>;
    /** Days whose lead count ≥ SPIKE_FACTOR × the trailing 7-day average. */
    leadVolumeSpikes: Array<{ date: string; leads: number; average: number }>;
  };
}