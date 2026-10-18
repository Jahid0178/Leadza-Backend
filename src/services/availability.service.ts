import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { ACTIVE_BOOKING_STATUSES } from "./booking-status";

/**
 * Availability (FEATURES §34–35, IMPLEMENTATION_PLAN step 27).
 *
 * Availability is computed ONLY from the business's configured `BusinessHour`
 * rows and its existing bookings. There is no calendar integration yet (step
 * 26), so when no hours are configured the answer is "no slots" — the AI may
 * never offer a time that no source reports (§25, §34). The calendar source
 * will plug in here behind `getAvailableSlots` when step 26 lands.
 *
 * Times are timezone-aware: opening hours are wall-clock in the business's
 * IANA timezone (`Business.timezone`), and every returned slot is a UTC
 * instant.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** JS `getUTCDay()` index (0 = Sunday) → the Prisma `Weekday` value. */
const WEEKDAY_BY_INDEX = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;
type WeekdayName = (typeof WEEKDAY_BY_INDEX)[number];

const DEFAULT_TZ = "Europe/London";

export interface AvailabilitySlot {
  startAt: Date;
  endAt: Date;
}

export interface AvailabilityResult {
  timezone: string;
  durationMinutes: number;
  slots: AvailabilitySlot[];
}

export interface GetAvailabilityInput {
  businessId: string;
  from: Date;
  to: Date;
  /** When given, the service's own duration drives the slot length. */
  serviceId?: string | null;
  /** Explicit override (used by tests / the AI tool). */
  durationMinutes?: number;
}

/** The wall-clock parts of `date` in `timeZone`. */
function partsInTz(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
  };
}

/** Offset (ms) of `timeZone` from UTC at the instant `date`. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const p = partsInTz(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - date.getTime();
}

/** A wall-clock time in `timeZone` → the UTC instant it denotes. */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = tzOffsetMs(new Date(guess), timeZone);
  return new Date(guess - offset);
}

/** Minutes since midnight for an "HH:MM" string. */
function toMinutes(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** A range's effective end in minutes; an overnight range caps at midnight. */
function rangeEndMinutes(startTime: string, endTime: string): number {
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  return end <= start ? 24 * 60 : end;
}

async function resolveTimezone(businessId: string): Promise<string> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { timezone: true },
  });
  return business?.timezone || DEFAULT_TZ;
}

async function resolveDuration(
  businessId: string,
  serviceId: string | null | undefined,
  override?: number,
): Promise<number> {
  let duration = override ?? env.BOOKING_DEFAULT_DURATION;
  if (serviceId) {
    const service = await prisma.service.findFirst({
      where: { id: serviceId, businessId },
      select: { duration: true },
    });
    if (service?.duration && service.duration > 0) duration = service.duration;
  }
  return Math.max(env.BOOKING_MIN_DURATION, duration);
}

/** The slot length a booking should use for a business/service. */
export async function resolveBookingDuration(
  businessId: string,
  serviceId?: string | null,
): Promise<number> {
  return resolveDuration(businessId, serviceId);
}

/** "HH:MM" wall-clock of `date` in `timeZone` (for AI-facing slot labels). */
export function formatTimeInTz(date: Date, timeZone: string): string {
  const p = partsInTz(date, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/**
 * Free slots between `from` and `to`, generated from opening hours and
 * excluding past times and slots blocked by an active booking.
 */
export async function getAvailableSlots(
  input: GetAvailabilityInput,
): Promise<AvailabilityResult> {
  const [timezone, durationMinutes] = await Promise.all([
    resolveTimezone(input.businessId),
    resolveDuration(input.businessId, input.serviceId, input.durationMinutes),
  ]);

  const [hours, bookings] = await Promise.all([
    prisma.businessHour.findMany({
      where: { businessId: input.businessId },
      orderBy: [{ weekday: "asc" }, { orderIndex: "asc" }],
    }),
    prisma.booking.findMany({
      where: {
        businessId: input.businessId,
        status: { in: [...ACTIVE_BOOKING_STATUSES] },
        startAt: { lt: input.to },
        endAt: { gt: input.from },
      },
      select: { startAt: true, endAt: true },
    }),
  ]);

  const hoursByWeekday = new Map<string, typeof hours>();
  for (const hour of hours) {
    const list = hoursByWeekday.get(hour.weekday) ?? [];
    list.push(hour);
    hoursByWeekday.set(hour.weekday, list);
  }

  const now = Date.now();
  const fromMs = input.from.getTime();
  const toMs = input.to.getTime();

  const start = partsInTz(input.from, timezone);
  const end = partsInTz(input.to, timezone);
  const firstLocalDay = Date.UTC(start.year, start.month - 1, start.day);
  const lastLocalDay = Date.UTC(end.year, end.month - 1, end.day);
  const spanDays = Math.min(
    env.BOOKING_MAX_RANGE_DAYS,
    Math.round((lastLocalDay - firstLocalDay) / DAY_MS) + 1,
  );

  const slots: AvailabilitySlot[] = [];

  for (let i = 0; i < spanDays; i += 1) {
    const dayUtc = new Date(firstLocalDay + i * DAY_MS);
    const year = dayUtc.getUTCFullYear();
    const month = dayUtc.getUTCMonth() + 1;
    const day = dayUtc.getUTCDate();
    const weekday: WeekdayName = WEEKDAY_BY_INDEX[dayUtc.getUTCDay()] ?? "MONDAY";
    const dayHours = hoursByWeekday.get(weekday) ?? [];

    for (const range of dayHours) {
      if (range.closed) continue;
      const rangeStart = toMinutes(range.startTime);
      const rangeEnd = rangeEndMinutes(range.startTime, range.endTime);

      for (let m = rangeStart; m + durationMinutes <= rangeEnd; m += durationMinutes) {
        const startAt = zonedTimeToUtc(
          year,
          month,
          day,
          Math.floor(m / 60),
          m % 60,
          timezone,
        );
        const startMs = startAt.getTime();
        if (startMs < fromMs || startMs >= toMs) continue;
        if (startMs <= now) continue;

        const endAt = new Date(startMs + durationMinutes * MINUTE_MS);
        const overlaps = bookings.some(
          (b) => b.startAt.getTime() < endAt.getTime() && b.endAt.getTime() > startMs,
        );
        if (overlaps) continue;

        slots.push({ startAt, endAt });
      }
    }
  }

  slots.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  return { timezone, durationMinutes, slots };
}

export type SlotUnavailableReason = "outside_hours" | "booked";

export interface SlotCheck {
  available: boolean;
  reason?: SlotUnavailableReason;
  timezone: string;
  /**
   * That weekday's open ranges ("09:00–17:00", "09:00–12:00") in the
   * business's timezone. Returned with an `outside_hours` refusal so the API
   * can name the limit instead of implying the slot was taken (§35).
   */
  openingHours?: string[];
}

/**
 * Re-check a single slot immediately before create/reschedule (§35): it must
 * sit inside an opening range and not overlap an active booking. `excludeId`
 * lets a reschedule ignore the booking being moved.
 */
export async function checkSlot(input: {
  businessId: string;
  startAt: Date;
  endAt: Date;
  timezone?: string;
  excludeBookingId?: string;
}): Promise<SlotCheck> {
  const timezone = input.timezone ?? (await resolveTimezone(input.businessId));

  const startParts = partsInTz(input.startAt, timezone);
  const weekday =
    WEEKDAY_BY_INDEX[
      new Date(
        Date.UTC(startParts.year, startParts.month - 1, startParts.day),
      ).getUTCDay()
    ] ?? "MONDAY";

  const hours = await prisma.businessHour.findMany({
    where: { businessId: input.businessId, weekday },
    orderBy: { orderIndex: "asc" },
  });

  const startMin = startParts.hour * 60 + startParts.minute;
  const endMin = startMin + Math.round((input.endAt.getTime() - input.startAt.getTime()) / MINUTE_MS);
  const openRanges = hours.filter((hour) => !hour.closed);
  const withinHours = openRanges.some(
    (hour) =>
      toMinutes(hour.startTime) <= startMin &&
      endMin <= rangeEndMinutes(hour.startTime, hour.endTime),
  );
  if (!withinHours) {
    return {
      available: false,
      reason: "outside_hours",
      timezone,
      openingHours: openRanges.map((hour) => `${hour.startTime}–${hour.endTime}`),
    };
  }

  const overlap = await prisma.booking.findFirst({
    where: {
      businessId: input.businessId,
      status: { in: [...ACTIVE_BOOKING_STATUSES] },
      ...(input.excludeBookingId ? { id: { not: input.excludeBookingId } } : {}),
      startAt: { lt: input.endAt },
      endAt: { gt: input.startAt },
    },
    select: { id: true },
  });
  if (overlap) return { available: false, reason: "booked", timezone };

  return { available: true, timezone };
}
