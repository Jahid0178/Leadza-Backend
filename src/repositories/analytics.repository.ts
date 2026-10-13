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
