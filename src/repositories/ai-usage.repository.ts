import { prisma } from "../lib/prisma";
import type {
  AdminAiUsageModelDto,
  AdminAiUsageTotalsDto,
  BusinessStatusInput,
} from "../validation/admin.schemas";

/**
 * AI usage queries (FEATURES §49, IMPLEMENTATION_PLAN step 32).
 *
 * One `ai_usage` row is written per agent run; everything the admin area shows
 * is aggregated from those rows with `_sum` / `groupBy`, so there is no
 * secondary counter to drift. Every read either filters by an explicit
 * `businessId` or is a cross-tenant admin query — the repository never derives
 * a tenant from request data (§7, §13).
 */

/** A monthly (or arbitrary) window; `null` start/end mean "all time". */
export interface AiUsagePeriod {
  start: Date;
  end: Date;
}

/** Where the period restricts `createdAt`, or no restriction at all. */
function periodWhere(period: AiUsagePeriod | null): { createdAt?: { gte: Date; lt: Date } } {
  return period ? { createdAt: { gte: period.start, lt: period.end } } : {};
}

/** The `_sum` shape every aggregate needs (Prisma returns `number | null`). */
const SUMS = { inputTokens: true, outputTokens: true, totalTokens: true, estimatedCost: true } as const;

type UsageSums = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimatedCost: number | null;
};

/** USD floats accumulate drift; keep six decimals like `estimateCostUsd`. */
function roundCost(value: number | null | undefined): number {
  if (!value) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}

function toTotals(sums: UsageSums, runs: number): AdminAiUsageTotalsDto {
  return {
    runs,
    inputTokens: sums.inputTokens ?? 0,
    outputTokens: sums.outputTokens ?? 0,
    totalTokens: sums.totalTokens ?? 0,
    estimatedCost: roundCost(sums.estimatedCost),
  };
}

/** One completed agent run, ready to persist (agents record via the service). */
export interface AiRunUsageEntry {
  businessId: string;
  conversationId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** USD, already rounded. */
  estimatedCostUsd: number;
}

/** Persist one run's usage. Created by the agent pipeline via the service. */
export function createAiUsage(entry: AiRunUsageEntry): Promise<unknown> {
  return prisma.aiUsage.create({
    data: {
      businessId: entry.businessId,
      conversationId: entry.conversationId,
      provider: entry.provider,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      totalTokens: entry.totalTokens,
      estimatedCost: entry.estimatedCostUsd,
    },
    select: { id: true },
  });
}

/** Platform totals for the §41 overview: every business, one window. */
export async function sumAiUsageForPlatform(
  period: AiUsagePeriod | null,
): Promise<AdminAiUsageTotalsDto & { businesses: number }> {
  const where = periodWhere(period);

  const [aggregate, groups] = await Promise.all([
    prisma.aiUsage.aggregate({ where, _count: { _all: true }, _sum: SUMS }),
    prisma.aiUsage.groupBy({ by: ["businessId"], where, _count: { _all: true } }),
  ]);

  return {
    ...toTotals(aggregate._sum, aggregate._count._all),
    businesses: groups.length,
  };
}

/** One tenant's totals: the per-business panel on the admin detail page. */
export async function sumAiUsageForBusiness(
  businessId: string,
  period: AiUsagePeriod | null,
): Promise<AdminAiUsageTotalsDto & { lastUsedAt: Date | null }> {
  const aggregate = await prisma.aiUsage.aggregate({
    where: { businessId, ...periodWhere(period) },
    _count: { _all: true },
    _sum: SUMS,
    _max: { createdAt: true },
  });

  return {
    ...toTotals(aggregate._sum, aggregate._count._all),
    lastUsedAt: aggregate._max.createdAt ?? null,
  };
}

/** Which models that tenant's runs used — for the per-business breakdown. */
export async function groupAiUsageByModel(
  businessId: string,
  period: AiUsagePeriod | null,
): Promise<AdminAiUsageModelDto[]> {
  const groups = await prisma.aiUsage.groupBy({
    by: ["provider", "model"],
    where: { businessId, ...periodWhere(period) },
    _count: { _all: true },
    _sum: SUMS,
    orderBy: [{ _sum: { estimatedCost: "desc" } }, { model: "asc" }],
  });

  return groups.map((group) => ({
    provider: group.provider,
    model: group.model,
    runs: group._count._all,
    inputTokens: group._sum.inputTokens ?? 0,
    outputTokens: group._sum.outputTokens ?? 0,
    totalTokens: group._sum.totalTokens ?? 0,
    estimatedCost: roundCost(group._sum.estimatedCost),
  }));
}

export interface AiUsageBusinessQuery {
  /** Matches the business name (platform operators search by tenant). */
  search?: string;
  page: number;
  pageSize: number;
}

export interface AiUsageBusinessRow extends AdminAiUsageTotalsDto {
  business: { id: string; name: string; status: BusinessStatusInput };
  lastUsedAt: Date | null;
}

/**
 * Per-business usage for /admin/usage. Cross-tenant by design: the router-wide
 * `requirePlatformAdmin` gate fronts every caller, and business names are
 * resolved in a second query so neither side does N+1 work.
 */
export async function listAiUsageForAdmin(
  query: AiUsageBusinessQuery,
  period: AiUsagePeriod | null,
): Promise<{ rows: AiUsageBusinessRow[]; total: number }> {
  // groupBy cannot filter on a relation, so search resolves business ids first.
  let businessIdFilter: { in: string[] } | undefined;
  if (query.search) {
    const matches = await prisma.business.findMany({
      where: { name: { contains: query.search, mode: "insensitive" } },
      select: { id: true },
    });
    if (matches.length === 0) return { rows: [], total: 0 };
    businessIdFilter = { in: matches.map((business) => business.id) };
  }

  const where = {
    ...periodWhere(period),
    ...(businessIdFilter ? { businessId: businessIdFilter } : {}),
  };

  const [page, all] = await Promise.all([
    prisma.aiUsage.groupBy({
      by: ["businessId"],
      where,
      _count: { _all: true },
      _sum: SUMS,
      _max: { createdAt: true },
      orderBy: [{ _sum: { estimatedCost: "desc" } }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.aiUsage.groupBy({ by: ["businessId"], where, _count: { _all: true } }),
  ]);

  if (page.length === 0) return { rows: [], total: all.length };

  const businesses = await prisma.business.findMany({
    where: { id: { in: page.map((group) => group.businessId) } },
    select: { id: true, name: true, status: true },
  });
  const names = new Map(businesses.map((business) => [business.id, business]));

  return {
    rows: page.map((group) => {
      const business = names.get(group.businessId);
      return {
        business: {
          id: group.businessId,
          name: business?.name ?? "Unknown business",
          status: (business?.status ?? "ACTIVE") as BusinessStatusInput,
        },
        ...toTotals(group._sum, group._count._all),
        lastUsedAt: group._max.createdAt ?? null,
      };
    }),
    total: all.length,
  };
}