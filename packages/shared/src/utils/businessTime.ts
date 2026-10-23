// Business-time calculator — the one SLA clock (#8973, spec §4.3 / §4.4).
//
// A calendar revision is a set of weekly open intervals in an IANA time zone.
// `addBusinessMinutes` moves forward through open time only;
// `businessMinutesBetween` counts the open time between two instants. With a
// null revision both are plain wall-clock arithmetic, which is exactly the
// pre-calendar SLA rule.
//
// Time-zone rules:
//   - Local <-> UTC conversion probes `Intl.DateTimeFormat#formatToParts`
//     (no tz library, no offset arithmetic across a transition).
//   - An interval is open from its local start to its local end, and counts
//     the REAL time between those two instants: a 00:00–06:00 interval is 300
//     minutes on a spring-forward night and 420 on a fall-back night.
//   - A local time that does not exist (inside a spring-forward gap) maps to
//     the instant after the gap; an ambiguous local time (fall-back) maps to
//     its earlier occurrence (the Temporal "compatible" rule).
//
// Cost (spec §4.4): targets up to 525,600 minutes are valid, so the walk jumps
// whole local weeks — the nominal weekly open time minus the holidays inside
// the week, found by binary search — and walks interval by interval only the
// first and last partial weeks, plus any week that contains a UTC-offset
// change.

import { isValidIanaTimezone } from './timezone';

/** Weekday 0 = Sunday … 6 = Saturday (JavaScript `getDay()` order). */
export type CalendarInterval = { weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6; startMinute: number; endMinute: number };
export type CalendarRevision = { timezone: string; intervals: readonly CalendarInterval[] };
/** Calendar-local dates `'YYYY-MM-DD'`, sorted ascending. */
export type HolidaySet = readonly string[];

export type RevisionValidation =
  | { ok: true }
  | { ok: false; code: 'NO_INTERVALS' | 'OVERLAP' | 'BAD_RANGE' | 'BAD_TIMEZONE' };

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const WEEK_DAYS = 7;
/** Widest UTC offset (+14:00) plus margin: a local week sits inside this UTC window. */
const OFFSET_MARGIN_MS = 15 * 3_600_000;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateRevision(rev: CalendarRevision): RevisionValidation {
  if (!isValidIanaTimezone(rev.timezone)) return { ok: false, code: 'BAD_TIMEZONE' };
  if (rev.intervals.length === 0) return { ok: false, code: 'NO_INTERVALS' };
  for (const interval of rev.intervals) {
    const { weekday, startMinute, endMinute } = interval;
    if (
      !Number.isInteger(weekday) || weekday < 0 || weekday > 6 ||
      !Number.isInteger(startMinute) || !Number.isInteger(endMinute) ||
      startMinute < 0 || endMinute > 1440 || startMinute >= endMinute
    ) {
      return { ok: false, code: 'BAD_RANGE' };
    }
  }
  const byDay = intervalsByWeekday(rev);
  for (const day of byDay) {
    for (let i = 1; i < day.length; i++) {
      if (day[i]!.startMinute < day[i - 1]!.endMinute) return { ok: false, code: 'OVERLAP' };
    }
  }
  return { ok: true };
}

/** Nominal open minutes in one week (ignores DST and holidays). */
export function weeklyOpenMinutes(rev: CalendarRevision): number {
  let total = 0;
  for (const interval of rev.intervals) total += interval.endMinute - interval.startMinute;
  return total;
}

// ---------------------------------------------------------------------------
// Public calculator
// ---------------------------------------------------------------------------

/**
 * The instant `minutes` of open time after `start`. Fractional minutes are
 * honoured at second precision (0.8 × 7 = 5.6 min = 336 s). A result that
 * lands exactly on an interval's close returns the close, not the next open.
 */
export function addBusinessMinutes(
  rev: CalendarRevision | null,
  holidays: HolidaySet,
  start: Date,
  minutes: number,
): Date {
  const amountMs = Math.round(minutes * 60) * 1000;
  if (rev === null) return new Date(start.getTime() + amountMs);
  if (!(amountMs > 0)) return new Date(start.getTime());

  const cal = prepare(rev, holidays);
  let remaining = amountMs;
  const cursor = start.getTime();

  // First (partial) local day, from the cursor.
  let day = cal.localDay(cursor);
  for (const [open, close] of cal.daySpans(day)) {
    if (close <= cursor) continue;
    const from = Math.max(open, cursor);
    const available = close - from;
    if (available >= remaining) return new Date(from + remaining);
    remaining -= available;
  }
  day += 1;

  for (;;) {
    const week = cal.weekMs(day);
    if (week < remaining) {
      remaining -= week;
      day += WEEK_DAYS;
      continue;
    }
    // The end falls inside this week: walk it day by day.
    for (let d = day; d < day + WEEK_DAYS; d++) {
      for (const [open, close] of cal.daySpans(d)) {
        const available = close - open;
        if (available >= remaining) return new Date(open + remaining);
        remaining -= available;
      }
    }
    // Unreachable while weekMs and daySpans agree; keep the loop total anyway.
    day += WEEK_DAYS;
  }
}

/** Open minutes between `a` and `b` (0 when `b <= a`). May be fractional. */
export function businessMinutesBetween(
  rev: CalendarRevision | null,
  holidays: HolidaySet,
  a: Date,
  b: Date,
): number {
  const from = a.getTime();
  const to = b.getTime();
  if (!(to > from)) return 0;
  if (rev === null) return (to - from) / MS_PER_MINUTE;

  const cal = prepare(rev, holidays);
  const firstDay = cal.localDay(from);
  const lastDay = cal.localDay(to);
  let total = 0;

  const clipDay = (d: number) => {
    for (const [open, close] of cal.daySpans(d)) {
      const s = Math.max(open, from);
      const e = Math.min(close, to);
      if (e > s) total += e - s;
    }
  };

  clipDay(firstDay);
  let day = firstDay + 1;
  while (day + WEEK_DAYS <= lastDay) {
    total += cal.weekMs(day);
    day += WEEK_DAYS;
  }
  for (; day <= lastDay; day++) clipDay(day);
  return total / MS_PER_MINUTE;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Local calendar day number: days since 1970-01-01 of the LOCAL date. */
type DayNumber = number;

interface PreparedCalendar {
  localDay(instant: number): DayNumber;
  /** Open [open, close) instants of one local day, in order; empty on a holiday. */
  daySpans(day: DayNumber): Array<[number, number]>;
  /** Open milliseconds in the seven local days starting at `day`. */
  weekMs(day: DayNumber): number;
}

function intervalsByWeekday(rev: CalendarRevision): CalendarInterval[][] {
  const byDay: CalendarInterval[][] = [[], [], [], [], [], [], []];
  for (const interval of rev.intervals) byDay[interval.weekday]?.push(interval);
  for (const day of byDay) day.sort((x, y) => x.startMinute - y.startMinute);
  return byDay;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    });
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

/** The local wall-clock reading of `instant`, expressed as if it were UTC. */
function localAsUtc(formatter: Intl.DateTimeFormat, instant: number): number {
  let year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;
  for (const part of formatter.formatToParts(new Date(instant))) {
    switch (part.type) {
      case 'year': year = Number(part.value); break;
      case 'month': month = Number(part.value); break;
      case 'day': day = Number(part.value); break;
      case 'hour': hour = Number(part.value) % 24; break;
      case 'minute': minute = Number(part.value); break;
      case 'second': second = Number(part.value); break;
      default: break;
    }
  }
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function prepare(rev: CalendarRevision, holidays: HolidaySet): PreparedCalendar {
  const weeklyMs = weeklyOpenMinutes(rev) * MS_PER_MINUTE;
  if (!(weeklyMs > 0)) {
    throw new Error('businessTime: calendar revision has no open time');
  }
  const formatter = formatterFor(rev.timezone);
  const byDay = intervalsByWeekday(rev);
  const dayMs = byDay.map((intervals) =>
    intervals.reduce((sum, i) => sum + (i.endMinute - i.startMinute) * MS_PER_MINUTE, 0));

  /** UTC offset (ms) in force at `instant`; whole seconds. */
  const offsetAt = (instant: number): number => {
    const floored = instant - (((instant % 1000) + 1000) % 1000);
    return localAsUtc(formatter, floored) - floored;
  };

  /** UTC instant of local wall time `naive` (a local reading expressed as UTC). */
  const toUtc = (naive: number): number => {
    const early = offsetAt(naive - MS_PER_DAY);
    const late = offsetAt(naive + MS_PER_DAY);
    if (early === late) return naive - early;
    const a = naive - early;
    const b = naive - late;
    const aValid = offsetAt(a) === early;
    const bValid = offsetAt(b) === late;
    if (aValid && bValid) return Math.min(a, b); // ambiguous: earlier occurrence
    if (aValid) return a;
    if (bValid) return b;
    return a; // gap: the pre-transition offset lands just after the gap
  };

  const weekday = (day: DayNumber): number => (((day + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday

  const isoDate = (day: DayNumber): string => new Date(day * MS_PER_DAY).toISOString().slice(0, 10);

  /** Index of the first holiday >= `date`. */
  const lowerBound = (date: string): number => {
    let lo = 0;
    let hi = holidays.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (holidays[mid]! < date) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const isHoliday = (day: DayNumber): boolean => {
    const date = isoDate(day);
    const i = lowerBound(date);
    return i < holidays.length && holidays[i] === date;
  };

  const daySpans = (day: DayNumber): Array<[number, number]> => {
    const intervals = byDay[weekday(day)]!;
    if (intervals.length === 0 || isHoliday(day)) return [];
    const midnight = day * MS_PER_DAY;
    return intervals.map((i): [number, number] => [
      toUtc(midnight + i.startMinute * MS_PER_MINUTE),
      toUtc(midnight + i.endMinute * MS_PER_MINUTE),
    ]);
  };

  const weekMs = (day: DayNumber): number => {
    const startNaive = day * MS_PER_DAY;
    const endNaive = (day + WEEK_DAYS) * MS_PER_DAY;
    // Every instant of the local week lies in this UTC window. One offset at
    // both ends means no transition inside (zones never change twice a week).
    if (offsetAt(startNaive - OFFSET_MARGIN_MS) === offsetAt(endNaive + OFFSET_MARGIN_MS)) {
      let ms = weeklyMs;
      const last = isoDate(day + WEEK_DAYS - 1);
      for (let i = lowerBound(isoDate(day)); i < holidays.length && holidays[i]! <= last; i++) {
        const holidayDay = Math.round(Date.parse(`${holidays[i]}T00:00:00Z`) / MS_PER_DAY);
        ms -= dayMs[weekday(holidayDay)]!;
        // Duplicate entries must not subtract a day twice.
        while (i + 1 < holidays.length && holidays[i + 1] === holidays[i]) i++;
      }
      return ms;
    }
    let ms = 0;
    for (let d = day; d < day + WEEK_DAYS; d++) {
      for (const [open, close] of daySpans(d)) ms += close - open;
    }
    return ms;
  };

  const localDay = (instant: number): DayNumber => Math.floor(localAsUtc(formatter, instant) / MS_PER_DAY);

  return { localDay, daySpans, weekMs };
}
