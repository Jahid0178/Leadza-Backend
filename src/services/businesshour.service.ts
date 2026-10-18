import { prisma } from "../lib/prisma";
import type { Weekday } from "../../generated/prisma/client";

/**
 * Internal availability check (FEATURES §12, IMPLEMENTATION_PLAN step 11).
 *
 * Feeds the booking flow (step 27) and the AI's availability answers (step
 * 20). The safety rule from §25 applies: when no hours are configured the
 * answer is always "closed / unknown" — the AI may never invent an opening
 * time that no BusinessHour row reports.
 */

const WEEKDAYS: Weekday[] = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];

/** Business timezone fallback — UK trade businesses (single default for now). */
const DEFAULT_BUSINESS_TZ = "Europe/London";

/** Default timezone used when a caller does not supply the business's own. */
export const BUSINESS_TZ = DEFAULT_BUSINESS_TZ;

export interface AvailabilityResult {
  open: boolean;
  /** True when the matched range is flagged as emergency-only cover. */
  emergency: boolean;
  /** Business-local weekday and "HH:MM" of the queried instant. */
  weekday: Weekday;
  time: string;
}

/** The weekday before `weekday` in the weekly cycle. */
function previousWeekday(weekday: Weekday): Weekday {
  const index = WEEKDAYS.indexOf(weekday);
  return WEEKDAYS[(index - 1 + WEEKDAYS.length) % WEEKDAYS.length] ?? "SUNDAY";
}

/** Minutes since midnight for an "HH:MM" string. */
function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Weekday + HH:MM of `at` in the business timezone. */
function localParts(
  at: Date,
  timeZone: string = DEFAULT_BUSINESS_TZ,
): { weekday: Weekday; time: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);

  const weekdayShort = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";

  const map: Record<string, Weekday> = {
    Mon: "MONDAY",
    Tue: "TUESDAY",
    Wed: "WEDNESDAY",
    Thu: "THURSDAY",
    Fri: "FRIDAY",
    Sat: "SATURDAY",
    Sun: "SUNDAY",
  };

  const time = `${hour}:${minute}`;
  return {
    weekday: map[weekdayShort] ?? "MONDAY",
    time,
    minutes: toMinutes(time),
  };
}

/**
 * Whether the business is open at `at` (defaults to now). A range covers the
 * instant when start <= t < end; overnight ranges (end < start) cover from
 * start to midnight and from midnight to end.
 */
export async function isOpenAt(
  businessId: string,
  at: Date = new Date(),
  timeZone: string = DEFAULT_BUSINESS_TZ,
): Promise<AvailabilityResult> {
  const { weekday, time, minutes } = localParts(at, timeZone);

  const hours = await prisma.businessHour.findMany({
    where: { businessId, weekday },
    orderBy: { orderIndex: "asc" },
  });

  const covers = (hour: { closed: boolean; startTime: string; endTime: string }) => {
    if (hour.closed) return false;
    const start = toMinutes(hour.startTime);
    const end = toMinutes(hour.endTime);
    if (start < end) return minutes >= start && minutes < end;
    // Overnight range (e.g. emergency cover 20:00–04:00): covers late
    // evening of its own weekday and the early hours of the next day.
    return minutes >= start || minutes < end;
  };

  const openRange = hours.find(covers);

  // Ranges from the previous weekday that spill past midnight still cover
  // the early morning of the queried day.
  const spillover = openRange
    ? null
    : await prisma.businessHour.findMany({
        where: { businessId, weekday: previousWeekday(weekday) },
        orderBy: { orderIndex: "asc" },
      });
  const spillRange = spillover?.find(
    (hour) => !hour.closed && toMinutes(hour.endTime) < toMinutes(hour.startTime) && minutes < toMinutes(hour.endTime),
  );

  const matched = openRange ?? spillRange;

  return {
    open: Boolean(matched),
    emergency: matched?.emergency ?? false,
    weekday,
    time,
  };
}

/** The business's configured hours for one weekday, in order. */
export async function hoursForWeekday(businessId: string, weekday: Weekday) {
  return prisma.businessHour.findMany({
    where: { businessId, weekday },
    orderBy: { orderIndex: "asc" },
  });
}
