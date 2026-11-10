/**
 * When a vendor update schedule runs (#11065, spec 4.2). Pure: no DB and no clock.
 *
 * One occurrence per calendar month, named for the month of its anchor night in
 * device-local time. Night 0 is the anchor; nights 1..catchUpNights follow it, at
 * the same wall-clock time. A catch-up night that falls in the next month still
 * belongs to the anchor's occurrence, so the key never changes under a run.
 *
 * Calendar edges (plan Review Focus 3):
 *  - A window start inside a spring-forward gap moves forward into it, once.
 *  - A window start in an autumn repeated hour resolves to one instant, once.
 *  - The window closes at its wall-clock time, so a clock change never pushes it
 *    further into the morning. A window wholly inside the gap keeps its length
 *    rather than vanishing.
 */
import {
  OEM_DAYS_OF_WEEK,
  type OemOutcome,
  type OemUpdatesInlineSettings,
} from '@breeze/shared';
import { getLocalTimeParts, zonedWallClockToUtc } from '../zonedTime';

export type OemWindowSchedule = OemUpdatesInlineSettings['schedule'];
export type OemOccurrenceSchedule = OemWindowSchedule & { catchUpNights: number };

export type LocalDate = { year: number; month: number; day: number };

export type OemOccurrence = {
  /** 'YYYY-MM' of the anchor date, device-local. */
  occurrenceKey: string;
  anchorDate: LocalDate;
  /** Which night `now` is inside: 0 is the anchor. Null when `now` is in no window. */
  nightIndex: number | null;
  /**
   * The window `now` is inside. Otherwise the next night's, or the last night's
   * once this occurrence has no night left.
   */
  windowStart: Date;
  windowEnd: Date;
  /** Its real length, which a clock change can make differ from the schedule's. */
  windowMinutes: number;
  inWindow: boolean;
  /** Every night of this occurrence has closed. */
  isPastLastNight: boolean;
};

export type OemNightWindow = { windowStart: Date; windowEnd: Date; windowMinutes: number };

/** Spec 4.2: up to 3 per occurrence, and then the device shows as Overdue. */
export const OEM_MAX_ATTEMPTS_PER_OCCURRENCE = 3;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const WEEK_INDEX = { first: 0, second: 1, third: 2, fourth: 3 } as const;

function addDays(date: LocalDate, days: number): LocalDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/** Calendar arithmetic in a fictitious UTC: a calendar date's weekday depends on no zone. */
function anchorDateOf(year: number, month: number, schedule: OemWindowSchedule): LocalDate {
  const target = OEM_DAYS_OF_WEEK.indexOf(schedule.dayOfWeek);
  if (schedule.weekOfMonth === 'last') {
    const lastDay = new Date(Date.UTC(year, month, 0));
    return { year, month, day: lastDay.getUTCDate() - ((lastDay.getUTCDay() - target + 7) % 7) };
  }
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return { year, month, day: 1 + ((target - firstWeekday + 7) % 7) + 7 * WEEK_INDEX[schedule.weekOfMonth] };
}

function windowOn(date: LocalDate, schedule: OemWindowSchedule, timezone: string): OemNightWindow {
  const [hour, minute] = schedule.windowStart.split(':').map((part) => Number.parseInt(part, 10)) as [number, number];
  const windowStart = zonedWallClockToUtc({ ...date, hour, minute }, timezone);
  const closes = new Date(Date.UTC(date.year, date.month - 1, date.day, hour + schedule.windowHours, minute));
  const wallClockClose = zonedWallClockToUtc(
    {
      year: closes.getUTCFullYear(),
      month: closes.getUTCMonth() + 1,
      day: closes.getUTCDate(),
      hour: closes.getUTCHours(),
      minute: closes.getUTCMinutes(),
    },
    timezone,
  );
  const windowEnd = wallClockClose.getTime() > windowStart.getTime()
    ? wallClockClose
    : new Date(windowStart.getTime() + schedule.windowHours * HOUR_MS);
  return { windowStart, windowEnd, windowMinutes: (windowEnd.getTime() - windowStart.getTime()) / MINUTE_MS };
}

/** The anchor night of the occurrence `now` belongs to. */
function occurrenceAnchor(schedule: OemOccurrenceSchedule, timezone: string, now: Date): LocalDate {
  const local = getLocalTimeParts(now, timezone);
  const thisMonth = anchorDateOf(local.year, local.month, schedule);
  const previous = new Date(Date.UTC(local.year, local.month - 2, 1));
  // This month's occurrence starts at its anchor night's window, and not before:
  // until then `now` still belongs to last month's, in catch-up or past its end.
  return now.getTime() >= windowOn(thisMonth, schedule, timezone).windowStart.getTime()
    ? thisMonth
    : anchorDateOf(previous.getUTCFullYear(), previous.getUTCMonth() + 1, schedule);
}

function occurrenceKeyOf(anchorDate: LocalDate): string {
  return `${String(anchorDate.year).padStart(4, '0')}-${String(anchorDate.month).padStart(2, '0')}`;
}

export function computeOccurrence(schedule: OemOccurrenceSchedule, timezone: string, now: Date): OemOccurrence {
  const anchorDate = occurrenceAnchor(schedule, timezone, now);
  const occurrenceKey = occurrenceKeyOf(anchorDate);

  let window = windowOn(anchorDate, schedule, timezone);
  for (let night = 0; night <= schedule.catchUpNights; night += 1) {
    window = windowOn(addDays(anchorDate, night), schedule, timezone);
    if (now.getTime() < window.windowStart.getTime()) {
      return { occurrenceKey, anchorDate, nightIndex: null, ...window, inWindow: false, isPastLastNight: false };
    }
    if (now.getTime() < window.windowEnd.getTime()) {
      return { occurrenceKey, anchorDate, nightIndex: night, ...window, inWindow: true, isPastLastNight: false };
    }
  }
  return { occurrenceKey, anchorDate, nightIndex: null, ...window, inWindow: false, isPastLastNight: true };
}

export type OemOccurrenceBoundaries = {
  occurrenceKey: string;
  /** The occurrence's last night: its window start, and its end, from which it is past its last night. */
  lastNightStart: Date;
  pastLastNightAt: Date;
  /** The next occurrence's first window start: the instant `computeOccurrence` changes key. */
  refreshAfter: Date;
};

/**
 * The occurrence `now` is in, as the instants that decide it (#11242): for every `t` in
 * `[now, refreshAfter)`, `computeOccurrence(schedule, timezone, t)` has this key, is past
 * its last night exactly when `t >= pastLastNightAt`, and then has `lastNightStart` as
 * its window start. So a stored copy answers like the live rule until `refreshAfter`.
 */
export function occurrenceBoundaries(schedule: OemOccurrenceSchedule, timezone: string, now: Date): OemOccurrenceBoundaries {
  const anchorDate = occurrenceAnchor(schedule, timezone, now);
  const lastNight = windowOn(addDays(anchorDate, schedule.catchUpNights), schedule, timezone);
  // The anchor month's successor, by calendar: day 1 is enough to name the month.
  const following = addDays({ year: anchorDate.year, month: anchorDate.month, day: 1 }, 31);
  const nextAnchor = anchorDateOf(following.year, following.month, schedule);
  return {
    occurrenceKey: occurrenceKeyOf(anchorDate),
    lastNightStart: lastNight.windowStart,
    pastLastNightAt: lastNight.windowEnd,
    refreshAfter: windowOn(nextAnchor, schedule, timezone).windowStart,
  };
}

/**
 * Tonight's window on the schedule's clock, whatever the calendar says: the window
 * `now` is inside, otherwise the next one. A pending reboot is held and retried
 * nightly (spec 4.5), and that does not stop at the occurrence's last night.
 */
export function nightlyWindow(schedule: OemWindowSchedule, timezone: string, now: Date): OemNightWindow {
  const local = getLocalTimeParts(now, timezone);
  const today: LocalDate = { year: local.year, month: local.month, day: local.day };
  // Yesterday's may still be open across midnight. Two days on is past any window.
  for (let offset = -1; offset <= 2; offset += 1) {
    const window = windowOn(addDays(today, offset), schedule, timezone);
    if (now.getTime() < window.windowEnd.getTime()) return window;
  }
  // Unreachable: tomorrow's window closes after `now` in every zone.
  throw new RangeError(`no window after ${now.toISOString()} in ${timezone}`);
}

/** The worker's tick. Its repeat lands on whole multiples of this, so a device sees one every this many minutes. */
export const OEM_TICK_MINUTES = 10;

/** The first hour of the window, or its first half when that is shorter. */
function spreadMinutes(windowMinutes: number): number {
  return Math.min(60, windowMinutes / 2);
}

/**
 * How far into the window this device starts, to spread out the downloads.
 *
 * Below the first hour (or half) of the window, and also at least two ticks before
 * {@link notAfterFor}: an offset in the last tick before it would be seen by no tick
 * at all, night after night, since both the offset and the tick phase are fixed. So a
 * 1-hour window spreads over its first 10 minutes, a 2-hour one over 40, and a window
 * of 3 hours or more over the full hour.
 */
export function stableOffsetMinutes(deviceId: string, windowMinutes: number): number {
  const beforeNotAfter = windowMinutes - spreadMinutes(windowMinutes) - 2 * OEM_TICK_MINUTES;
  const bound = Math.floor(Math.min(spreadMinutes(windowMinutes), beforeNotAfter));
  if (bound <= 0) return 0;
  // FNV-1a: small, stable across processes, and no crypto import for a spread.
  let hash = 0x811c9dc5;
  for (let i = 0; i < deviceId.length; i += 1) {
    hash ^= deviceId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % bound;
}

/** The latest a run may start: late enough to use the window, early enough to finish in it. */
export function notAfterFor(windowEnd: Date, windowMinutes: number): Date {
  return new Date(windowEnd.getTime() - spreadMinutes(windowMinutes) * MINUTE_MS);
}

/**
 * Outcomes that use one of the attempts. Not here: `blocked_on_battery` and
 * `blocked_reboot_pending` (spec 4.2), where the tool never got to run and the next
 * night retries. `retry_later` is here because a tool that ran and asked to be
 * retried did use one; {@link consumesAttempt} takes out the refusals.
 */
export const ATTEMPT_CONSUMING_OUTCOMES: ReadonlySet<OemOutcome> = new Set<OemOutcome>([
  'success',
  'success_reboot_required',
  'no_updates',
  'partial',
  'failed',
  'not_supported',
  'tool_unavailable',
  'blocked_no_recovery_key',
  'retry_later',
  'interrupted',
]);

/** The agent's `retry_later` codes from before any vendor tool started (agent runner.go). */
const REFUSED_BEFORE_START_CODES: ReadonlySet<string> = new Set([
  'not_after_passed',
  'run_in_flight',
  'preflight_failed',
  'flash_in_progress',
]);

export function consumesAttempt(outcome: OemOutcome, errorCode: string | null): boolean {
  if (outcome === 'retry_later' && errorCode !== null && REFUSED_BEFORE_START_CODES.has(errorCode)) return false;
  return ATTEMPT_CONSUMING_OUTCOMES.has(outcome);
}
