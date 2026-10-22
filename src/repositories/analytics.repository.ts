import { prisma } from "../lib/prisma";
import { findMembership } from "./membership.repository";

/**
 * Dashboard aggregates for one business (FEATURES §28, IMPLEMENTATION_PLAN
 * step 17). Every query is scoped to a businessId whose membership was
 * verified first — a foreign businessId returns null and the controller
 * answers 404 (agent.md §7, §13, §52).
 *
 * Funnel semantics — counts are cumulative "reached this stage" numbers so
 * the cards read as a funnel (18 → 11 → 7), matching the §28 example:
 *   new      — leads awaiting a first action (status NEW)
 *   qualified— leads that reached QUALIFIED or beyond (QUALIFIED/BOOKED/WON)
 *   booked   — BOOKED or WON
 *   won      — WON
 *   conversionRate — WON ÷ non-SPAM leads × 100 (spam isn't a real
 *     opportunity, so it never dilutes the rate), 1 decimal, 0 when empty
 *   needsAttention — untouched NEW leads + HUMAN_REQUESTED conversations
 */

/** A lead as the dashboard lists it — enough for a row, no full detail. */
export interface DashboardLead {
  id: string;
  status: string;
  urgency: string | null;
  customerMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  customer: { id: string; name: string; phone: string | null; email: string | null };
  service: { id: string; name: string } | null;
}

/** A conversation as the needs-attention list shows it. */
export interface DashboardConversation {
  id: string;
  status: string;
  channel: string;
  updatedAt: Date;
  customer: { id: string; name: string; phone: string | null; email: string | null };
  lastMessage: { content: string; sender: string; createdAt: Date } | null;
}

export interface DashboardSummary {
  /** Counts by funnel stage. */
  newLeads: number;
  qualified: number;
  booked: number;
  won: number;
  /** All leads of the business (including SPAM). */
  total: number;
  /** WON ÷ non-SPAM leads × 100, one decimal (0 when there is no data). */
  conversionRate: number;
  /** newLeads + humanRequestedConversations. */
  needsAttention: number;
  humanRequestedConversations: number;
  /** Latest leads regardless of status (5). */
  recentLeads: DashboardLead[];
  /** Latest untouched NEW leads for the attention list (5). */
  attentionLeads: DashboardLead[];
  /** Customers waiting on a human (5). */
  humanRequested: DashboardConversation[];
}

const LEAD_LIST_LIMIT = 5;

/** Map a Prisma lead row (with relations) to the dashboard DTO. */
function toLeadDto(row: {
  id: string;
  status: string;
  urgency: string | null;
  customerMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  customer: { id: string; name: string; phone: string | null; email: string | null };
  service: { id: string; name: string } | null;
}): DashboardLead {
  return {
    id: row.id,
    status: row.status,
    urgency: row.urgency,
    customerMessage: row.customerMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    customer: row.customer,
    service: row.service,
  };
}

/**
 * The dashboard summary for one business the caller is a member of, or
 * null when the caller isn't (never leak another tenant's existence, §13).
 */
export async function getDashboardForBusiness(
  userId: string,
  businessId: string,
): Promise<DashboardSummary | null> {
  const membership = await findMembership(userId, businessId);
  if (!membership) return null;

  const [statusCounts, humanRequestedCount, recentLeads, attentionLeads, humanRequested] =
    await Promise.all([
      prisma.lead.groupBy({
        by: ["status"],
        where: { businessId },
        _count: { _all: true },
      }),
      prisma.conversation.count({
        where: { businessId, status: "HUMAN_REQUESTED" },
      }),
      prisma.lead.findMany({
        where: { businessId },
        orderBy: { createdAt: "desc" },
        take: LEAD_LIST_LIMIT,
        include: {
          customer: {
            select: { id: true, name: true, phone: true, email: true },
          },
          service: { select: { id: true, name: true } },
        },
      }),
      prisma.lead.findMany({
        where: { businessId, status: "NEW" },
        orderBy: { createdAt: "desc" },
        take: LEAD_LIST_LIMIT,
        include: {
          customer: {
            select: { id: true, name: true, phone: true, email: true },
          },
          service: { select: { id: true, name: true } },
        },
      }),
      prisma.conversation.findMany({
        where: { businessId, status: "HUMAN_REQUESTED" },
        orderBy: { updatedAt: "desc" },
        take: LEAD_LIST_LIMIT,
        include: {
          customer: {
            select: { id: true, name: true, phone: true, email: true },
          },
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { content: true, sender: true, createdAt: true },
          },
        },
      }),
    ]);

  const count = (status: string) =>
    statusCounts.find((row) => row.status === status)?._count._all ?? 0;

  const won = count("WON");
  const bookedOnly = count("BOOKED");
  const qualifiedOnly = count("QUALIFIED");
  const newLeads = count("NEW");
  const spam = count("SPAM");
  const total = statusCounts.reduce((sum, row) => sum + row._count._all, 0);

  // Cumulative funnel: "reached this stage", so the numbers only shrink.
  const booked = bookedOnly + won;
  const qualified = qualifiedOnly + booked;

  // Conversion = won ÷ real opportunities (spam excluded), 1 decimal.
  const eligible = total - spam;
  const conversionRate =
    eligible === 0 ? 0 : Math.round((won / eligible) * 1000) / 10;

  return {
    newLeads,
    qualified,
    booked,
    won,
    total,
    conversionRate,
    needsAttention: newLeads + humanRequestedCount,
    humanRequestedConversations: humanRequestedCount,
    recentLeads: recentLeads.map(toLeadDto),
    attentionLeads: attentionLeads.map(toLeadDto),
    humanRequested: humanRequested.map((conversation) => ({
      id: conversation.id,
      status: conversation.status,
      channel: conversation.channel,
      updatedAt: conversation.updatedAt,
      customer: conversation.customer,
      lastMessage: conversation.messages[0]
        ? {
            content: conversation.messages[0].content,
            sender: conversation.messages[0].sender,
            createdAt: conversation.messages[0].createdAt,
          }
        : null,
    })),
  };
}

/* ------------------------------------------------------------------------ *
 * Business analytics (FEATURES §50, IMPLEMENTATION_PLAN step 33)
 *
 * One combined read for the /dashboard/analytics page: funnel, average
 * response time, lead sources and a per-day volume series. Everything is
 * derived from stored rows (no counters) and scoped to one membership-
 * verified businessId, exactly like the dashboard above.
 *
 * Window semantics — a period always means "enquiries whose lead was created
 * inside the window" (a cohort funnel). A lead from an earlier window that
 * converts later stays in its own creation window, which keeps the funnel
 * monotone and the source/daily charts consistent with it. `all` = all time.
 * ------------------------------------------------------------------------ */

/** Rolling calendar-day windows the UI offers, plus "all time". */
export type AnalyticsRange = "7" | "30" | "90" | "all";

export interface AnalyticsFunnel {
  /** All leads in the window except SPAM. */
  enquiries: number;
  /** Reached QUALIFIED or beyond (cumulative). */
  qualified: number;
  /** Reached BOOKED or WON (cumulative). */
  booked: number;
  /** Reached WON. */
  won: number;
  /** WON ÷ enquiries × 100, one decimal, 0 when empty. */
  conversionRate: number;
}

export interface AnalyticsSourceCount {
  source: string;
  count: number;
}

export interface AnalyticsResponseTime {
  /**
   * Average minutes from a conversation's first customer message to the
   * first AI/human reply, one decimal; null when nothing was replied to yet.
   */
  averageMinutes: number | null;
  /** Conversations that received at least one reply. */
  respondedCount: number;
}

/** One business-local day of the volume series. */
export interface AnalyticsVolumeDay {
  /** YYYY-MM-DD in the business's timezone. */
  date: string;
  leads: number;
  conversations: number;
}

export interface AnalyticsStats {
  /** `days: null` = the current all-time view; start follows the same rule. */
  period: { days: number | null; start: string | null; end: string };
  funnel: AnalyticsFunnel;
  responseTime: AnalyticsResponseTime;
  sources: AnalyticsSourceCount[];
  volume: AnalyticsVolumeDay[];
  totals: { leads: number; conversations: number };
  /** IANA timezone the daily buckets were rendered in (for transparency). */
  timezone: string;
}

/** Cap for the all-time volume series so the chart stays drawable. */
const MAX_VOLUME_DAYS = 365;

/** YYYY-MM-DD for an instant, in a timezone ("en-CA" sorts like ISO). */
function localDayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Shift a YYYY-MM-DD key by whole calendar days (naive date math). */
function shiftDayKey(key: string, deltaDays: number): string {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + deltaDays)).toISOString().slice(0, 10);
}

/** Milliseconds between UTC and the wall clock of the timezone at an instant. */
function wallClockOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUTC = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUTC - date.getTime();
}

/** UTC instant of local midnight for a YYYY-MM-DD key in a timezone. */
function localMidnight(key: string, timeZone: string): Date {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  // Guess at noon UTC, then walk the wall-clock offset twice to absorb DST
  // edges (a midnight transition can shift the offset between passes).
  let instant = Date.UTC(year, month - 1, day, 12);
  for (let i = 0; i < 2; i++) {
    instant = Date.UTC(year, month - 1, day, 12) - wallClockOffsetMs(new Date(instant), timeZone);
  }
  return new Date(instant);
}

/**
 * The member-facing stats read behind GET /api/v1/analytics/stats, or null
 * when the caller isn't a member (controller answers 404, §13). The
 * aggregation itself lives in computeStatsForBusiness so the admin business
 * drill-down (§51) returns identical numbers.
 */
export async function getStatsForBusiness(
  userId: string,
  businessId: string,
  range: AnalyticsRange,
): Promise<AnalyticsStats | null> {
  const membership = await findMembership(userId, businessId);
  if (!membership) return null;
  return computeStatsForBusiness(businessId, range);
}

/**
 * The business analytics computation behind GET /api/v1/analytics/stats
 * (member-side) and the admin business drill-down (FEATURES §50/§51) —
 * pure aggregates over one verified businessId, no authorization here: each
 * caller proves tenancy (membership / platform role) before calling.
 */
export async function computeStatsForBusiness(
  businessId: string,
  range: AnalyticsRange,
): Promise<AnalyticsStats | null> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { timezone: true },
  });
  if (!business) return null;
  const timezone = business.timezone;

  const now = new Date();
  const todayKey = localDayKey(now, timezone);
  const dayCount = range === "all" ? null : Number(range);
  const volumeKeys: string[] = [];
  let start: Date | null = null;

  if (dayCount !== null) {
    // The window is `dayCount` full business-local days ending today.
    for (let i = dayCount - 1; i >= 0; i--) volumeKeys.push(shiftDayKey(todayKey, -i));
    start = localMidnight(volumeKeys[0] as string, timezone);
  }

  const periodWhere = start ? { createdAt: { gte: start } } : {};

  const [statusCounts, sourceCounts, leadRows, conversationRows, messageRows] = await Promise.all([
    prisma.lead.groupBy({
      by: ["status"],
      where: { businessId, ...periodWhere },
      _count: { _all: true },
    }),
    prisma.lead.groupBy({
      by: ["source"],
      where: { businessId, ...periodWhere },
      _count: { _all: true },
    }),
    prisma.lead.findMany({
      where: { businessId, ...periodWhere },
      select: { createdAt: true },
    }),
    prisma.conversation.findMany({
      where: { businessId, ...periodWhere },
      select: { id: true, createdAt: true },
    }),
    // All messages of the window's conversations, oldest first, so a single
    // pass finds each conversation's first customer message and first reply.
    prisma.message.findMany({
      where: { conversation: { businessId, ...periodWhere } },
      select: { conversationId: true, sender: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  // Cumulative funnel scoped to the window — identical semantics to the
  // dashboard (§28): spam never counts as a real opportunity.
  const count = (status: string) =>
    statusCounts.find((row) => row.status === status)?._count._all ?? 0;
  const won = count("WON");
  const booked = count("BOOKED") + won;
  const qualified = count("QUALIFIED") + booked;
  const total = statusCounts.reduce((sum, row) => sum + row._count._all, 0);
  const spam = count("SPAM");
  const enquiries = total - spam;
  const conversionRate = enquiries === 0 ? 0 : Math.round((won / enquiries) * 1000) / 10;

  // First response per conversation: walk messages oldest → newest, so the
  // first reply seen for a conversation is its earliest. The enquiry anchor is
  // the first customer message, falling back to the conversation's creation
  // (the public forms post the enquiry text at creation time).
  const enquiryAt = new Map<string, number>();
  const conversationAt = new Map(conversationRows.map((row) => [row.id, row.createdAt.getTime()]));
  const responseMs = new Map<string, number>();
  for (const message of messageRows) {
    if (message.sender === "CUSTOMER") {
      if (!enquiryAt.has(message.conversationId)) {
        enquiryAt.set(message.conversationId, message.createdAt.getTime());
      }
      continue;
    }
    if (message.sender === "SYSTEM" || responseMs.has(message.conversationId)) continue;
    const anchor =
      enquiryAt.get(message.conversationId) ?? conversationAt.get(message.conversationId);
    // Messages below are always scoped to conversations of this business
    // (the query filters on the relation), so the anchor is always there.
    if (anchor === undefined) continue;
    responseMs.set(message.conversationId, message.createdAt.getTime() - anchor);
  }

  let averageMinutes: number | null = null;
  if (responseMs.size > 0) {
    let sum = 0;
    for (const ms of responseMs.values()) sum += ms;
    const averageMs = sum / responseMs.size;
    averageMinutes = Math.round((averageMs / 60000) * 10) / 10;
  }

  const sources = sourceCounts
    .map((row) => ({ source: row.source, count: row._count._all }))
    .sort((a, b) => b.count - a.count);

  // Daily buckets in the business's timezone. For "all time" the range spans
  // from the earliest activity (capped so the chart stays drawable) to today.
  let keys = volumeKeys;
  if (dayCount === null) {
    let earliest: number | undefined;
    for (const lead of leadRows) {
      if (earliest === undefined || lead.createdAt.getTime() < earliest) {
        earliest = lead.createdAt.getTime();
      }
    }
    for (const conversation of conversationRows) {
      if (earliest === undefined || conversation.createdAt.getTime() < earliest) {
        earliest = conversation.createdAt.getTime();
      }
    }
    if (earliest !== undefined) {
      const firstKey = localDayKey(new Date(earliest), timezone);
      for (let key = firstKey; key <= todayKey; key = shiftDayKey(key, 1)) {
        keys.push(key);
      }
      // ISO date strings compare correctly with <= above.
      if (keys.length > MAX_VOLUME_DAYS) keys = keys.slice(-MAX_VOLUME_DAYS);
    }
  }

  const buckets = new Map(keys.map((key) => [key, { date: key, leads: 0, conversations: 0 }]));
  for (const lead of leadRows) {
    const bucket = buckets.get(localDayKey(lead.createdAt, timezone));
    if (bucket) bucket.leads += 1;
  }
  for (const conversation of conversationRows) {
    const bucket = buckets.get(localDayKey(conversation.createdAt, timezone));
    if (bucket) bucket.conversations += 1;
  }

  return {
    period: {
      days: dayCount,
      start: start ? start.toISOString() : null,
      end: now.toISOString(),
    },
    funnel: { enquiries, qualified, booked, won, conversionRate },
    responseTime: { averageMinutes, respondedCount: responseMs.size },
    sources,
    volume: [...buckets.values()],
    totals: { leads: total, conversations: conversationRows.length },
    timezone,
  };
}
