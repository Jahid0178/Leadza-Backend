import { Prisma } from "../../generated/prisma/client";
import type { LeadSource, LeadStatus } from "../../generated/prisma/client";
import type {
  AdminAnalyticsActivityDto,
  AdminAnalyticsActivityEntryDto,
  AdminAnalyticsOverviewDto,
  AdminAiPerformanceDto,
  AdminAnalyticsWindowDto,
  AdminBusinessUsageDto,
  AdminBusinessUsagePageDto,
  AdminLeadAnalyticsDto,
  AdminAnalyticsMetric,
} from "../validation/admin-analytics.schemas";
import { NO_ACTIVITY_DAYS, SPIKE_FACTOR, SPIKE_TRAILING_DAYS } from "../validation/admin-analytics.schemas";
import { prisma } from "../lib/prisma";

/**
 * Platform-wide analytics aggregates (FEATURES §51, the "Admin analytics"
 * build). Deliberately cross-tenant — safety lives in the router-wide
 * `requireAuth, requirePlatformAdmin` gate; no function here ever trusts a
 * client id for authorization.
 *
 * ## Metric definitions (FEATURES §51 + spec §2)
 * Centralized here so the API and the dashboard can never disagree:
 *
 * - **Window**: every window metric counts rows inside
 *   `[from 00:00Z, to+1day 00:00Z)` (from inclusive, to inclusive as a
 *   calendar day). Buckets are UTC days (the platform's reporting timezone).
 * - **Lead volume**: distinct leads created inside the window.
 * - **Qualified leads**: cohort leads (created in the window) whose CURRENT
 *   status is QUALIFIED, BOOKED or WON — "reached as of now" semantics,
 *   computed from rows so pre-event history still reports. Event-based
 *   metrics below are exact by construction.
 * - **Conversion**: won ÷ cohort (spam never counts as an opportunity),
 *   one decimal, 0 when the cohort is empty.
 * - **Lead-to-booking rate**: distinct cohort leads with a qualifying
 *   booking ÷ eligible cohort × 100 (§2's documented example).
 * - **Appointments**: bookings CREATED inside the window, cancelled
 *   excluded (the usage metrics' established convention).
 * - **AI-handled**: conversations with ≥ 1 AI reply, opened in the window.
 * - **Resolved without human**: AI-handled threads with **no escalation on
 *   the ledger** — AnalyticsEvent CONVERSATION_ESCALATED rows or the AI
 *   handoff tool (`AiToolCall.tool = handoffToHuman`). An escalation is a
 *   workflow choice; a separate AI_RUN_FAILED metric never mixes in.
 * - **AI qualification**: the AI tools deliberatey cannot change a lead's
 *   status, so "AI qualification" is reported honestly as distinct leads the
 *   AI scored or enriched (calculateLeadScore / updateLead tool calls, OK).
 * - **First response**: first customer message → first AI reply (fallback:
 *   conversation creation), averaged over threads with an AI reply.
 * - **Handling time**: first customer message → last message on threads
 *   with ≥ 2 messages ("where measurable").
 * - **Snapshot metrics** (business totals, awaiting human, today's leads)
 *   describe current state and carry no comparison.
 */

/** A resolved reporting window + the previous equivalent window. */
interface ResolvedWindow {
  /** Inclusive first day, YYYY-MM-DD. */
  from: string;
  /** Inclusive last day, YYYY-MM-DD. */
  to: string;
  /** Inclusive lower bound (from midnight). */
  start: Date;
  /** Exclusive upper bound (to midnight + 1 day). */
  end: Date;
  /** Previous window of equal length, immediately before. */
  previousStart: Date;
  previousEnd: Date;
  /** Previous-window day bounds for the DTO (null before the platform existed). */
  previousFrom: string | null;
  previousTo: string | null;
}

/** Default window: the last 30 days ending today (UTC). */
function resolveWindow(query: { from?: string; to?: string }): ResolvedWindow {
  const today = new Date();
  const from = query.from ?? `${isoDay(shiftUtc(today, -(30 - 1)))}T00:00:00.000Z`;
  const to = query.to ?? `${isoDay(today)}T00:00:00.000Z`;

  const start = new Date(from);
  const end = new Date(new Date(to).getTime() + 86400000);
  const previousEnd = start;
  const previousStart = new Date(start.getTime() - (end.getTime() - start.getTime()));

  return {
    from: from.slice(0, 10),
    to: to.slice(0, 10),
    start,
    end,
    previousStart,
    previousEnd,
    previousFrom: null, // filled by markPreviousAvailability below
    previousTo: null,
  };
}

const DAY_MS = 86400000;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/**
 * Fill in the previous-window labels only when the window itself is
 * historical enough for a fair comparison (§ "where sufficient historical
 * data is available"): the platform must have existed at the previous
 * window's start. The earliest registration is the platform's birth.
 */
async function resolvePrevious(window: ResolvedWindow): Promise<AdminAnalyticsWindowDto> {
  const earliest = await prisma.business.findFirst({
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  const hasPrevious = (earliest?.createdAt.getTime() ?? 0) <= window.previousStart.getTime();

  return {
    from: window.from,
    to: window.to,
    endExclusive: window.end.toISOString(),
    previousFrom: hasPrevious ? isoDay(window.previousStart) : null,
    previousTo: hasPrevious ? isoDay(shiftUtc(window.previousEnd, -1)) : null,
    reportingTimezone: "UTC",
  };
}

/** Row filter for "created inside the window". */
const createdIn = (start: Date, end: Date) => ({ createdAt: { gte: start, lt: end } });

const QUALIFIED_STATUSES: LeadStatus[] = ["QUALIFIED", "BOOKED", "WON"];

/* ------------------------------------------------------------------ *
 * 1 — GET /admin/analytics/overview
 * ------------------------------------------------------------------ */

/** Same metric, current vs previous window (null when not comparable). */
function metric(current: number, previous: number | null): AdminAnalyticsMetric {
  return { current, previous };
}

export async function getAnalyticsOverview(
  query: ResolvedQueryFromSchema,
): Promise<AdminAnalyticsOverviewDto> {
  const window = resolveWindow(query);
  const windowDto = await resolvePrevious(window);

  const cohort = createdIn(window.start, window.end);
  const previousCohort = createdIn(window.previousStart, window.previousEnd);

  const eligibleWhere = (cohort: { createdAt: { gte: Date; lt: Date } }) => ({
    ...cohort,
    status: { not: "SPAM" as const },
  });

  const [
    totalLeads,
    totalLeadsPrev,
    qualifiedLeads,
    qualifiedLeadsPrev,
    wonLeads,
    wonLeadsPrev,
    eligibleLeads,
    eligibleLeadsPrev,
    leadsToday,
    newBusinesses,
    newBusinessesPrev,
    bookedAppointments,
    bookedAppointmentsPrev,
    escalations,
    escalationsPrev,
    aiRunFailures,
    aiRunFailuresPrev,
  ] = await Promise.all([
    prisma.lead.count({ where: cohort }),
    prisma.lead.count({ where: previousCohort }),
    prisma.lead.count({ where: { ...cohort, status: { in: QUALIFIED_STATUSES } } }),
    prisma.lead.count({ where: { ...previousCohort, status: { in: QUALIFIED_STATUSES } } }),
    prisma.lead.count({ where: { ...cohort, status: "WON" } }),
    prisma.lead.count({ where: { ...previousCohort, status: "WON" } }),
    prisma.lead.count({ where: eligibleWhere(cohort) }),
    prisma.lead.count({ where: eligibleWhere(previousCohort) }),
    prisma.lead.count({ where: { createdAt: { gte: startOfUtcToday() } } }),
    prisma.business.count({ where: cohort }),
    windowDto.previousFrom === null
      ? Promise.resolve(0)
      : prisma.business.count({ where: createdIn(window.previousStart, window.previousEnd) }),
    bookingCount(cohort),
    bookingCount(previousCohort),
    eventCount2("CONVERSATION_ESCALATED", cohort),
    windowDto.previousFrom === null
      ? Promise.resolve(0)
      : eventCount2("CONVERSATION_ESCALATED", previousCohort),
    eventCount2("AI_RUN_FAILED", cohort),
    windowDto.previousFrom === null
      ? Promise.resolve(0)
      : eventCount2("AI_RUN_FAILED", previousCohort),
  ]);

  const [businessTotal, businessActive, businessSuspended, awaitingHuman] = await Promise.all([
    prisma.business.count(),
    prisma.business.count({ where: { status: "ACTIVE" } }),
    prisma.business.count({ where: { status: "SUSPENDED" } }),
    prisma.conversation.count({ where: { status: "HUMAN_REQUESTED" } }),
  ]);

  return {
    window: windowDto,
    businesses: {
      total: businessTotal,
      active: businessActive,
      suspended: businessSuspended,
      newRegistrations: metric(newBusinesses, hasPrevious(windowDto) ? newBusinessesPrev : null),
    },
    leads: {
      total: metric(totalLeads, hasPrevious(windowDto) ? totalLeadsPrev : null),
      today: leadsToday,
      qualified: metric(qualifiedLeads, hasPrevious(windowDto) ? qualifiedLeadsPrev : null),
      bookedAppointments: metric(
        bookedAppointments,
        hasPrevious(windowDto) ? bookedAppointmentsPrev : null,
      ),
      conversionRate: metric(
        rate(wonLeads, eligibleLeads),
        hasPrevious(windowDto) ? rate(wonLeadsPrev, eligibleLeadsPrev) : null,
      ),
    },
    conversations: {
      awaitingHuman,
      escalations: metric(escalations, hasPrevious(windowDto) ? escalationsPrev : null),
      // A technical failure — never an escalation, never a conversion outcome.
      aiRunFailures: metric(aiRunFailures, hasPrevious(windowDto) ? aiRunFailuresPrev : null),
    },
  };
}

/** Whether the response carries a comparison (sufficient history). */
function hasPrevious(windowDto: AdminAnalyticsWindowDto): boolean {
  return windowDto.previousFrom !== null;
}

/** The rate helper shared with the conversion trend: 1 decimal, 0 when empty. */
function rate(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** Bookings created in a window, cancelled excluded (§ usage convention). */
function bookingCount(cohort: { createdAt: { gte: Date; lt: Date } }) {
  return prisma.booking.count({ where: { ...cohort, status: { not: "CANCELLED" } } });
}

/** AnalyticsEvent rows of one type inside a window (optionally scoped). */
function eventCount2(
  type: "CONVERSATION_ESCALATED" | "AI_RUN_FAILED",
  cohort: { createdAt: { gte: Date; lt: Date } },
  businessId?: string,
) {
  return prisma.analyticsEvent.count({
    where: { type, ...cohort, ...(businessId ? { businessId } : {}) },
  });
}

/** Midnight UTC today, exclusive end bound excluded (§41 pattern). */
function startOfUtcToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The window query the controller already parsed (from/to days). */
type ResolvedQueryFromSchema = { from?: string; to?: string };

/** Optional per-lead filters the leads/ai-performance endpoints accept. */
interface LeadWindowFilters {
  businessId?: string;
  source?: LeadSource;
  status?: LeadStatus;
}

/** The cohort filter with the optional business/source/status filters. */
function leadCohortWhere(
  window: { start: Date; end: Date },
  filters: LeadWindowFilters,
) {
  return {
    createdAt: { gte: window.start, lt: window.end },
    ...(filters.businessId ? { businessId: filters.businessId } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };
}

/** Inclusive UTC days between two YYYY-MM-DD bounds. */
function* dayRange(from: string, to: string): Iterable<string> {
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  for (
    let cursor = new Date(`${from}T00:00:00.000Z`);
    cursor.getTime() <= end;
    cursor = shiftUtc(cursor, 1)
  ) {
    yield isoDay(cursor);
  }
}

export async function getLeadAnalytics(
  query: ResolvedQueryFromSchema & LeadWindowFilters,
): Promise<AdminLeadAnalyticsDto> {
  const window = resolveWindow(query);
  const windowDto = await resolvePrevious(window);
  const where = leadCohortWhere(window, query);

  // Database-side aggregation for the day buckets: date_trunc pinned to UTC,
  // won and non-spam carried in the same pass so the conversion trend needs
  // no extra query (spec §6 — never load the dataset into app memory).
  const dayRows = await prisma.$queryRaw<
    Array<{ day: string; total: number; won: number; eligible: number }>
  >`
    SELECT (date_trunc('day', "createdAt" AT TIME ZONE 'UTC'))::text AS day,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'WON')::int AS won,
           COUNT(*) FILTER (WHERE status <> 'SPAM')::int AS eligible
    FROM leads
    WHERE "createdAt" >= ${window.start} AND "createdAt" < ${window.end}
      ${query.businessId ? Prisma.sql`AND "businessId" = ${query.businessId}` : Prisma.empty}
      ${query.source ? Prisma.sql`AND "source" = ${query.source}` : Prisma.empty}
      ${query.status ? Prisma.sql`AND "status" = ${query.status}` : Prisma.empty}
    GROUP BY day
    ORDER BY day
  `;

  const byDay = new Map(dayRows.map((row) => [row.day.slice(0, 10), row]));
  const volumeByDay: AdminLeadAnalyticsDto["volumeByDay"] = [];
  const conversionTrend: AdminLeadAnalyticsDto["conversionTrend"] = [];
  for (const day of dayRange(window.from, window.to)) {
    const row = byDay.get(day);
    volumeByDay.push({ date: day, leads: row?.total ?? 0 });
    conversionTrend.push({
      date: day,
      rate: rate(row?.won ?? 0, row?.eligible ?? 0),
      leads: row?.total ?? 0,
    });
  }

  // Cohort aggregates + the funnel, all in parallel.
  const [statusCounts, sourceCounts, businessCounts, serviceCounts, cohortIds, cohortEligible, bookings] =
    await Promise.all([
      prisma.lead.groupBy({ by: ["status"], where, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ["source"], where, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ["businessId"], where, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ["serviceId"], where, _count: { _all: true } }),
      prisma.lead.findMany({ where, select: { id: true } }),
      prisma.lead.count({ where: { ...where, status: { not: "SPAM" } } }),
      // Appointments flow: bookings CREATED in the window, cancelled
      // excluded — scoped by businessId only (source/status are lead-cohort
      // filters that cannot apply to a booking row).
      prisma.booking.count({
        where: {
          createdAt: { gte: window.start, lt: window.end },
          status: { not: "CANCELLED" },
          ...(query.businessId ? { businessId: query.businessId } : {}),
        },
      }),
    ]);

  const count = (status: string) =>
    statusCounts.find((row) => row.status === status)?._count._all ?? 0;
  const won = count("WON");
  const booked = count("BOOKED") + won;
  const qualified = count("QUALIFIED") + booked;
  const total = statusCounts.reduce((sum, row) => sum + row._count._all, 0);
  const spam = count("SPAM");

  // §2's rate, cohort-anchored: of the filtered cohort's leads, distinct
  // ones carrying ANY qualifying booking (whenever it was created), divided
  // by the eligible cohort. Leads belong to a business, so the booking set
  // needs no additional business scope once restricted to cohort ids.
  const cohortIdSet = new Set(cohortIds.map((lead) => lead.id));
  const distinctBookingLeads = new Set(
    (
      await prisma.booking.findMany({
        where: { leadId: { in: [...cohortIdSet] } },
        select: { leadId: true },
      })
    ).flatMap((row) => (row.leadId ? [row.leadId] : [])),
  ).size;

  const [topBusinesses, byService] = await Promise.all([
    resolveBusinessNames(
      businessCounts
        .map((row) => ({ businessId: row.businessId, count: row._count._all }))
        .sort((a, b) => b.count - a.count)
        .slice(0, TOP_LIMIT),
    ),
    resolveServiceNames(
      serviceCounts.map((row) => ({ serviceId: row.serviceId, count: row._count._all })),
    ),
  ]);

  return {
    window: windowDto,
    filters: {
      businessId: query.businessId ?? null,
      source: query.source ?? null,
      status: query.status ?? null,
    },
    volumeByDay,
    conversionTrend,
    sources: sourceCounts
      .map((row) => ({ source: row.source as string, count: row._count._all }))
      .sort((a, b) => b.count - a.count),
    statusDistribution: statusCounts
      .map((row) => ({ status: row.status as string, count: row._count._all }))
      .sort((a, b) => b.count - a.count),
    qualifiedVsUnqualified: {
      qualified,
      unqualified: total - spam - qualified,
      spam,
    },
    funnel: {
      // Cumulative cohort funnel (§28 semantics) — identical to the tenant
      // page so a business number never disagrees across surfaces.
      enquiries: total - spam,
      qualified,
      booked,
      won,
    },
    bookedAppointments: bookings,
    leadToBookingRate: rate(distinctBookingLeads, cohortEligible),
    topBusinesses,
    byService,
  };
}

const TOP_LIMIT = 10;

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Batch-resolve business names for top-N rows (no N+1). */
async function resolveBusinessNames(
  rows: Array<{ businessId: string; count: number }>,
): Promise<Array<{ businessId: string; name: string; leads: number }>> {
  if (rows.length === 0) return [];
  const businesses = await prisma.business.findMany({
    where: { id: { in: rows.map((row) => row.businessId) } },
    select: { id: true, name: true },
  });
  const names = new Map(businesses.map((business) => [business.id, business.name]));
  return rows.map((row) => ({
    businessId: row.businessId,
    name: names.get(row.businessId) ?? "Unknown business",
    leads: row.count,
  }));
}

/** Batch-resolve service names (null serviceId → the "None" bucket). */
async function resolveServiceNames(
  rows: Array<{ serviceId: string | null; count: number }>,
): Promise<Array<{ serviceId: string | null; name: string; leads: number }>> {
  const ids = rows.flatMap((row) => (row.serviceId ? [row.serviceId] : []));
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const services = await prisma.service.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    for (const service of services) names.set(service.id, service.name);
  }
  return rows
    .map((row) => ({
      serviceId: row.serviceId,
      name: row.serviceId ? (names.get(row.serviceId) ?? "Unknown service") : "None specified",
      leads: row.count,
    }))
    .sort((a, b) => b.leads - a.leads)
    .slice(0, TOP_LIMIT);
}

/* ------------------------------------------------------------------ *
 * 3 — GET /admin/analytics/ai-performance
 * ------------------------------------------------------------------ */

/** Escalation count split by initiator. Escalating is a workflow choice the
 * ledger records; AI_RUN_FAILED is reported separately, never summed here. */
async function escalationCounts(
  window: { start: Date; end: Date },
  businessId?: string,
): Promise<{ byAi: number; byStaff: number; escalationConversationIds: string[] }> {
  const [toolRows, eventRows] = await Promise.all([
    // AI-initiated handoffs — one AiToolCall ledger row per escalation.
    prisma.aiToolCall.findMany({
      where: {
        tool: "handoffToHuman",
        status: "OK",
        createdAt: { gte: window.start, lt: window.end },
        ...(businessId ? { businessId } : {}),
      },
      select: { conversationId: true },
    }),
    prisma.analyticsEvent.findMany({
      where: {
        type: "CONVERSATION_ESCALATED",
        createdAt: { gte: window.start, lt: window.end },
        ...(businessId ? { businessId } : {}),
      },
      select: { conversationId: true, initiator: true },
    }),
  ]);

  // The tool ALSO emits a CONVERSATION_ESCALATED event (initiator "AI") for
  // the same escalation — the staff count must therefore only read
  // initiator "STAFF" rows, or the AI handoff would count twice.
  const byStaff = eventRows.filter((row) => row.initiator !== "AI").length;

  return {
    byAi: toolRows.length,
    byStaff,
    escalationConversationIds: [
      ...new Set([
        ...toolRows.map((row) => row.conversationId),
        ...eventRows.flatMap((row) => (row.conversationId ? [row.conversationId] : [])),
      ]),
    ],
  };
}

export async function getAiPerformanceAnalytics(
  query: ResolvedQueryFromSchema & { businessId?: string },
): Promise<AdminAiPerformanceDto> {
  const window = resolveWindow(query);
  const windowDto = await resolvePrevious(window);
  const businessId = query.businessId;
  const scope = businessId ? { businessId } : {};

  const convCohort = createdIn(window.start, window.end);
  const aiHandledWhere = {
    ...convCohort,
    ...scope,
    messages: { some: { sender: "AI" as const } },
  };

  const [
    escalations,
    previousEscalations,
    aiHandled,
    aiHandledPrevious,
    conversationRows,
    messages,
    qualificationGroups,
    previousQualificationGroups,
    aiBookings,
    previousAiBookings,
    failures,
    previousFailures,
    cohortLeadIds,
    cohortEligible,
  ] = await Promise.all([
    escalationCounts(window, businessId),
    hasPrevious(windowDto)
      ? escalationCounts(
          { start: window.previousStart, end: window.previousEnd },
          businessId,
        )
      : Promise.resolve({ byAi: 0, byStaff: 0, escalationConversationIds: [] }),
    prisma.conversation.count({ where: aiHandledWhere }),
    hasPrevious(windowDto)
      ? prisma.conversation.count({
          where: {
            ...createdIn(window.previousStart, window.previousEnd),
            ...scope,
            messages: { some: { sender: "AI" as const } },
          },
        })
      : Promise.resolve(0),
    // Creation times as the fallback enquiry anchor (public flows post the
    // first customer message at conversation creation).
    prisma.conversation.findMany({
      where: aiHandledWhere,
      select: { id: true, createdAt: true },
    }),
    prisma.message.findMany({
      where: { conversation: aiHandledWhere },
      select: { conversationId: true, sender: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.aiToolCall.groupBy({
      by: ["leadId"],
      where: {
        tool: { in: ["calculateLeadScore", "updateLead"] },
        status: "OK",
        leadId: { not: null },
        createdAt: { gte: window.start, lt: window.end },
        ...scope,
      },
      _count: { _all: true },
    }),
    hasPrevious(windowDto)
      ? prisma.aiToolCall.groupBy({
          by: ["leadId"],
          where: {
            tool: { in: ["calculateLeadScore", "updateLead"] },
            status: "OK",
            leadId: { not: null },
            createdAt: { gte: window.previousStart, lt: window.previousEnd },
            ...scope,
          },
          _count: { _all: true },
        })
      : Promise.resolve([] as Array<{ leadId: string | null; _count: { _all: number } }>),
    prisma.booking.count({
      where: {
        origin: "AI",
        status: { not: "CANCELLED" },
        ...createdIn(window.start, window.end),
        ...scope,
      },
    }),
    hasPrevious(windowDto)
      ? prisma.booking.count({
          where: {
            origin: "AI",
            status: { not: "CANCELLED" },
            ...createdIn(window.previousStart, window.previousEnd),
            ...scope,
          },
        })
      : Promise.resolve(0),
    eventCount2("AI_RUN_FAILED", convCohort, businessId),
    hasPrevious(windowDto)
      ? eventCount2("AI_RUN_FAILED", createdIn(window.previousStart, window.previousEnd), businessId)
      : Promise.resolve(0),
    prisma.lead.findMany({
      where: { ...convCohort, ...scope },
      select: { id: true },
    }),
    prisma.lead.count({
      where: {
        ...convCohort,
        ...scope,
        status: { not: "SPAM" },
      },
    }),
  ]);

  // First response + handling, walked oldest → newest over the cohort's
  // messages (the §50 repository's pattern).
  const createdAtByConversation = new Map(
    conversationRows.map((conversation) => [conversation.id, conversation.createdAt.getTime()]),
  );
  const enquiryAt = new Map<string, number>();
  const firstAiAt = new Map<string, number>();
  const lastAt = new Map<string, number>();
  const messageCount = new Map<string, number>();
  for (const message of messages) {
    const conversationId = message.conversationId;
    const at = message.createdAt.getTime();
    messageCount.set(conversationId, (messageCount.get(conversationId) ?? 0) + 1);
    if (message.sender === "CUSTOMER") {
      if (!enquiryAt.has(conversationId)) enquiryAt.set(conversationId, at);
    }
    if (message.sender === "AI") {
      if (!firstAiAt.has(conversationId)) firstAiAt.set(conversationId, at);
    }
    if (!lastAt.has(conversationId) || at > (lastAt.get(conversationId) ?? 0)) {
      lastAt.set(conversationId, at);
    }
  }

  const responseSpans: number[] = [];
  const handlingSpans: number[] = [];
  for (const [conversationId, aiAt] of firstAiAt) {
    const enquiry =
      enquiryAt.get(conversationId) ?? createdAtByConversation.get(conversationId) ?? aiAt;
    responseSpans.push(aiAt - enquiry);
    const last = lastAt.get(conversationId) ?? aiAt;
    if ((messageCount.get(conversationId) ?? 0) >= 2 && last > enquiry) {
      handlingSpans.push(last - enquiry);
    }
  }
  const averageMinutes = (spans: number[]) =>
    spans.length === 0 ? null : Math.round((average(spans) / 60000) * 10) / 10;

  const resolvedWithoutHuman = await prisma.conversation.count({
    where: {
      ...convCohort,
      ...scope,
      messages: { some: { sender: "AI" as const } },
      ...(escalations.escalationConversationIds.length > 0
        ? { id: { notIn: escalations.escalationConversationIds } }
        : {}),
    },
  });
  const resolvedWithoutHumanPrevious = hasPrevious(windowDto)
    ? await prisma.conversation.count({
        where: {
          ...createdIn(window.previousStart, window.previousEnd),
          ...scope,
          messages: { some: { sender: "AI" as const } },
          ...(previousEscalations.escalationConversationIds.length > 0
            ? { id: { notIn: previousEscalations.escalationConversationIds } }
            : {}),
        },
      })
    : 0;

  const [awaitingReview] = await Promise.all([
    prisma.conversation.count({
      where: { status: "HUMAN_REQUESTED", ...scope },
    }),
  ]);

  // §2's rate, cohort-anchored (identical definition to the leads endpoint):
  // distinct cohort leads with any qualifying booking ÷ eligible cohort. The
  // booking set is restricted to cohort ids, so no extra scope is needed.
  const cohortIdSet = new Set(cohortLeadIds.map((lead) => lead.id));
  const distinctBookingLeads = new Set(
    (
      await prisma.booking.findMany({
        where: { leadId: { in: [...cohortIdSet] } },
        select: { leadId: true },
      })
    ).flatMap((row) => (row.leadId ? [row.leadId] : [])),
  ).size;

  return {
    window: windowDto,
    filters: { businessId: businessId ?? null },
    aiHandled: metric(aiHandled, hasPrevious(windowDto) ? aiHandledPrevious : null),
    resolvedWithoutHuman: metric(
      resolvedWithoutHuman,
      hasPrevious(windowDto) ? resolvedWithoutHumanPrevious : null,
    ),
    escalations: {
      total: metric(
        escalations.byAi + escalations.byStaff,
        hasPrevious(windowDto) ? previousEscalations.byAi + previousEscalations.byStaff : null,
      ),
      byAi: escalations.byAi,
      byStaff: escalations.byStaff,
      awaitingReview,
    },
    averageFirstResponseMinutes: averageMinutes(responseSpans),
    averageHandlingMinutes: averageMinutes(handlingSpans),
    aiQualificationLeads: metric(
      qualificationGroups.length,
      hasPrevious(windowDto) ? previousQualificationGroups.length : null,
    ),
    aiBookedAppointments: metric(
      aiBookings,
      hasPrevious(windowDto) ? previousAiBookings : null,
    ),
    leadToBookingRate: rate(distinctBookingLeads, cohortEligible),
    aiRunFailures: metric(failures, hasPrevious(windowDto) ? previousFailures : null),
  };
}

/* ------------------------------------------------------------------ *
 * 4 — GET /admin/analytics/businesses (+ last activity for §5's alerts)
 * ------------------------------------------------------------------ */

/** One business's window metrics + derived last activity. */
interface BusinessUsage {
  leads: number;
  qualified: number;
  aiConversations: number;
  appointments: number;
  /** Latest lead/conversation/booking activity or AI run, or null. */
  lastActivity: Date | null;
}

/**
 * Batched per-business window metrics for a set of business ids — every
 * query here is a single aggregate, never per-business loops (spec §6).
 */
async function usageForBusinesses(
  businessIds: string[],
  window: { start: Date; end: Date },
): Promise<Map<string, BusinessUsage>> {
  if (businessIds.length === 0) return new Map();

  const scoped = { businessId: { in: businessIds }, createdAt: { gte: window.start, lt: window.end } };
  const [leadGroups, qualifiedGroups, conversationRows, bookingGroups, leadActivity, conversationActivity, bookingActivity, aiUsageActivity] =
    await Promise.all([
      prisma.lead.groupBy({ by: ["businessId"], where: scoped, _count: { _all: true } }),
      prisma.lead.groupBy({
        by: ["businessId"],
        where: { ...scoped, status: { in: QUALIFIED_STATUSES } },
        _count: { _all: true },
      }),
      prisma.conversation.findMany({
        where: { ...scoped, messages: { some: { sender: "AI" as const } } },
        select: { businessId: true },
      }),
      prisma.booking.groupBy({
        by: ["businessId"],
        where: { ...scoped, status: { not: "CANCELLED" } },
        _count: { _all: true },
      }),
      // Derived last activity (not stored anywhere — computed here in four
      // batched maxima; the newest of the four wins per business).
      prisma.lead.groupBy({
        by: ["businessId"],
        where: { businessId: { in: businessIds } },
        _max: { updatedAt: true },
      }),
      prisma.conversation.groupBy({
        by: ["businessId"],
        where: { businessId: { in: businessIds } },
        _max: { updatedAt: true },
      }),
      prisma.booking.groupBy({
        by: ["businessId"],
        where: { businessId: { in: businessIds } },
        _max: { updatedAt: true },
      }),
      prisma.aiUsage.groupBy({
        by: ["businessId"],
        where: { businessId: { in: businessIds } },
        _max: { createdAt: true },
      }),
    ]);

  const aiConversations = new Map<string, number>();
  for (const row of conversationRows) {
    aiConversations.set(row.businessId, (aiConversations.get(row.businessId) ?? 0) + 1);
  }

  const latestActivity = new Map<string, Date>();
  // Every groupBy rows' _max carries one timestamp; take the newest per
  // business across the four activity sources.
  const track = (rows: Array<{ businessId: string; _max: Record<string, Date | null> }>) => {
    for (const row of rows) {
      for (const stamp of Object.values(row._max)) {
        if (!stamp) continue;
        const current = latestActivity.get(row.businessId);
        if (!current || stamp.getTime() > current.getTime()) {
          latestActivity.set(row.businessId, stamp);
        }
      }
    }
  };
  track(leadActivity);
  track(conversationActivity);
  track(bookingActivity);
  track(aiUsageActivity);

  const usage = new Map<string, BusinessUsage>();
  for (const businessId of businessIds) {
    usage.set(businessId, {
      leads: leadGroups.find((row) => row.businessId === businessId)?._count._all ?? 0,
      qualified: qualifiedGroups.find((row) => row.businessId === businessId)?._count._all ?? 0,
      aiConversations: aiConversations.get(businessId) ?? 0,
      appointments: bookingGroups.find((row) => row.businessId === businessId)?._count._all ?? 0,
      lastActivity: latestActivity.get(businessId) ?? null,
    });
  }
  return usage;
}

export async function listBusinessUsageAnalytics(
  query: {
    search?: string;
    status?: "ACTIVE" | "SUSPENDED";
    sort: "name" | "status" | "createdAt" | "leads" | "lastActivity";
    order: "asc" | "desc";
    page: number;
    pageSize: number;
  } & ResolvedQueryFromSchema,
): Promise<AdminBusinessUsagePageDto> {
  const window = resolveWindow(query);
  const windowDto = await resolvePrevious(window);
  const search = query.search
    ? { name: { contains: query.search, mode: "insensitive" as const } }
    : {};
  const statusFilter = query.status ? { status: query.status } : {};
  const listWhere = { ...search, ...statusFilter };

  /** Basic identity rows sorted by a whitelisted column (DB-side). */
  const identityFields = { id: true, name: true, status: true, createdAt: true } as const;

  let identities: Array<{ id: string; name: string; status: string; createdAt: Date }>;
  let total: number;

  // Column-sorted values (name/status/registered) are pure DB columns;
  // metric-sorted values (leads/last activity) are window aggregates over
  // ALL matching businesses, then filtered to the page — bounded by the
  // number of businesses (platform tables, not lead tables).
  if (query.sort === "leads" || query.sort === "lastActivity") {
    const all = await prisma.business.findMany({
      where: listWhere,
      select: identityFields,
      orderBy: { createdAt: "asc" },
    });
    const usage = await usageForBusinesses(
      all.map((business) => business.id),
      window,
    );
    const withMetric = all.map((business) => ({
      ...business,
      metric: query.sort === "leads"
        ? (usage.get(business.id)?.leads ?? 0)
        : (usage.get(business.id)?.lastActivity?.getTime() ?? 0),
    }));
    withMetric.sort((a, b) => (query.order === "desc" ? b.metric - a.metric : a.metric - b.metric));
    total = withMetric.length;
    identities = withMetric.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
  } else {
    const [rows, count] = await Promise.all([
      prisma.business.findMany({
        where: listWhere,
        select: identityFields,
        orderBy: { [query.sort]: query.order },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.business.count({ where: listWhere }),
    ]);
    identities = rows;
    total = count;
  }

  const usage = await usageForBusinesses(
    identities.map((business) => business.id),
    window,
  );

  const businesses: AdminBusinessUsageDto[] = identities.map((business) => {
    const perBusiness = usage.get(business.id);
    return {
      id: business.id,
      name: business.name,
      status: business.status,
      createdAt: business.createdAt.toISOString(),
      leads: perBusiness?.leads ?? 0,
      aiConversations: perBusiness?.aiConversations ?? 0,
      qualified: perBusiness?.qualified ?? 0,
      appointments: perBusiness?.appointments ?? 0,
      lastActivity: perBusiness?.lastActivity?.toISOString() ?? null,
    };
  });

  return { window: windowDto, businesses, total, page: query.page, pageSize: query.pageSize };
}

/* ------------------------------------------------------------------ *
 * 6 — GET /admin/analytics/activity
 * ------------------------------------------------------------------ */

/** How an entry kind renders, one per AnalyticsEventType. */
const EVENT_KINDS: Record<string, { kind: string; title: (initiator: string | null) => string }> = {
  BUSINESS_REGISTERED: { kind: "business.registered", title: () => "New business registered" },
  LEAD_STATUS_CHANGED: { kind: "event.lead_status", title: () => "Lead status changed" },
  CONVERSATION_ESCALATED: {
    kind: "event.escalation",
    title: (initiator) =>
      initiator === "AI" ? "The AI asked a person for help" : "Conversation escalated",
  },
  AI_RUN_FAILED: { kind: "event.ai_failure", title: () => "AI run failed" },
  CHANNEL_INTEGRATION_FAILED: {
    kind: "event.channel",
    title: () => "Channel integration failed",
  },
  CHANNEL_INTEGRATION_RECOVERED: {
    kind: "event.channel",
    title: () => "Channel integration recovered",
  },
};

export async function getActivityAnalytics(
  query: {
    type?: string;
    businessId?: string;
    page: number;
    pageSize: number;
  } & ResolvedQueryFromSchema,
): Promise<AdminAnalyticsActivityDto> {
  const window = resolveWindow(query);
  const windowDto = await resolvePrevious(window);

  const where = {
    createdAt: { gte: window.start, lt: window.end },
    ...(query.type ? { type: query.type as never } : {}),
    ...(query.businessId ? { businessId: query.businessId } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.analyticsEvent.findMany({
      where,
      orderBy: { createdAt: "desc" as const },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.analyticsEvent.count({ where }),
  ]);

  // Business names for the page rows — one batched query, no N+1.
  const businessIds = [...new Set(rows.map((row) => row.businessId))];
  const businesses = await prisma.business.findMany({
    where: { id: { in: businessIds } },
    select: { id: true, name: true },
  });
  const names = new Map(businesses.map((business) => [business.id, business.name]));

  // Lead rows referenced by LEAD_STATUS_CHANGED entries — customer names
  // resolved in the same batch, again no N+1.
  const statusRows = rows.filter((row) => row.type === "LEAD_STATUS_CHANGED" && row.leadId);
  const leadNames = new Map<string, string>();
  if (statusRows.length > 0) {
    const leads = await prisma.lead.findMany({
      where: { id: { in: statusRows.flatMap((row) => (row.leadId ? [row.leadId] : [])) } },
      select: { id: true, customer: { select: { name: true } } },
    });
    for (const lead of leads) leadNames.set(lead.id, lead.customer.name);
  }

  const entries: AdminAnalyticsActivityEntryDto[] = rows.map((row) => {
    const shape = EVENT_KINDS[row.type as string];
    const kind = shape?.kind ?? "event.other";
    const title = shape?.title(row.initiator) ?? row.type;
    let detail: string | null = null;
    if (row.type === "LEAD_STATUS_CHANGED") {
      detail =
        `${row.fromStatus ?? "?"} → ${row.toStatus ?? "?"}` +
        (row.leadId && leadNames.get(row.leadId) ? ` · ${leadNames.get(row.leadId)}` : "");
    } else if (row.type === "CONVERSATION_ESCALATED" && row.initiator !== "AI") {
      detail = "Marked by staff";
    } else if (row.type === "AI_RUN_FAILED" && row.metadata) {
      const meta = row.metadata as { provider?: string; reason?: string };
      detail = [meta.provider, meta.reason].filter(Boolean).join(" · ") || null;
    }
    return {
      id: row.id,
      kind,
      type: row.type,
      title,
      detail,
      businessId: row.businessId,
      businessName: names.get(row.businessId) ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  });

  // Detection-rule alerts (documented parameters, spec §5) — computed with
  // fixed rules and capped lists; never presented as thresholds invented on
  // the fly.
  const [awaitingConversationRows, activeBusinesses] = await Promise.all([
    prisma.conversation.findMany({
      where: { status: "HUMAN_REQUESTED" },
      orderBy: { updatedAt: "asc" as const },
      take: 5,
      select: { id: true, updatedAt: true, business: { select: { name: true } } },
    }),
    prisma.business.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true, createdAt: true },
    }),
  ]);

  const activity = await usageForBusinesses(
    activeBusinesses.map((business) => business.id),
    { start: shiftUtc(new Date(), -NO_ACTIVITY_DAYS), end: new Date() },
  );
  const quietBusinesses = activeBusinesses
    .filter((business) => {
      const last = activity.get(business.id)?.lastActivity;
      // Never active at all counts as quiet only a full window past
      // registration — brand-new businesses are not "no activity".
      const since = last?.getTime() ?? business.createdAt.getTime();
      return since <= new Date(Date.now() - NO_ACTIVITY_DAYS * 86400000).getTime();
    })
    .slice(0, 5)
    .map((business) => ({
      id: business.id,
      name: business.name,
      lastActivity:
        (activity.get(business.id)?.lastActivity ?? business.createdAt).toISOString(),
    }));

  const spikeCandidates = await leadCountsByDay(30);
  const trailingCounts: number[] = [];
  const leadVolumeSpikes: AdminAnalyticsActivityDto["alerts"]["leadVolumeSpikes"] = [];
  for (const day of spikeCandidates) {
    // Rule: day ≥ SPIKE_FACTOR × the trailing 7-day average, and only when
    // there was traffic before it (a first day of traffic is growth).
    if (
      trailingCounts.length === SPIKE_TRAILING_DAYS &&
      average(trailingCounts) > 0 &&
      day.leads >= SPIKE_FACTOR * average(trailingCounts)
    ) {
      leadVolumeSpikes.push({ date: day.date, leads: day.leads, average: average(trailingCounts) });
      if (leadVolumeSpikes.length >= 5) break;
    }
    trailingCounts.push(day.leads);
    if (trailingCounts.length > SPIKE_TRAILING_DAYS) trailingCounts.shift();
  }

  return {
    window: windowDto,
    entries,
    total,
    page: query.page,
    pageSize: query.pageSize,
    alerts: {
      awaitingHuman: awaitingConversationRows.map((row) => ({
        conversationId: row.id,
        businessName: row.business.name,
        updatedAt: row.updatedAt.toISOString(),
      })),
      quietBusinesses,
      leadVolumeSpikes,
    },
  };
}

/** Daily platform lead counts for the last `days` UTC days, oldest first. */
async function leadCountsByDay(days: number): Promise<Array<{ date: string; leads: number }>> {
  const start = startOfUtcDay(shiftUtc(new Date(), -(days - 1)));
  const totals = await prisma.$queryRaw<Array<{ day: string; count: number }>>`
    SELECT (date_trunc('day', "createdAt" AT TIME ZONE 'UTC'))::text AS day,
           COUNT(*)::int AS count
    FROM leads
    WHERE "createdAt" >= ${start}
    GROUP BY day
  `;
  const byDay = new Map(
    totals.map((row) => [row.day.slice(0, 10) as string, row.count]),
  );
  const out: Array<{ date: string; leads: number }> = [];
  for (const day of dayRange(isoDay(start), isoDay(new Date()))) {
    out.push({ date: day, leads: byDay.get(day) ?? 0 });
  }
  return out;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}