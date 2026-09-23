import { canonicalizeTimezone } from '@breeze/shared';
import type { ReportPeriodInput, ReportPeriodKind } from '@breeze/shared';
import { periodSchema } from '@breeze/shared';
import { resolveOrgTimezone, resolvePartnerTimezone } from '../portal/timezone';
import { organizationScope, runInReportScope } from '../reportScope';
import type { ReportOwner } from '../siteScope';

// The period contract lives in @breeze/shared (Task 5) so the web forms and the
// server schema cannot drift. Re-exported here for the three config schemas
// and the generators, which import from this module rather than
// '@breeze/shared' directly (single import path, per the plan brief).
export type { ReportPeriodInput, ReportPeriodKind } from '@breeze/shared';
export { periodSchema } from '@breeze/shared';

export type ResolvedReportPeriod = {
  start: Date;
  end: Date;
  label: string;
  timeZone: string;
  kind: ReportPeriodKind;
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Validate a timezone name; unknown zones degrade to UTC rather than throwing
 * mid-generation (a scheduled report must still produce SOMETHING even if a
 * stored org/partner timezone has rotted — spec framing for §3.3 R3).
 * `canonicalizeTimezone` (from `@breeze/shared`) already returns null for an
 * unknown zone; fall back to it directly rather than re-validating with
 * `Intl.DateTimeFormat` ourselves.
 */
function safeTimezone(timeZone: string): string {
  return canonicalizeTimezone(timeZone) ?? 'UTC';
}

/**
 * The UTC instant of local midnight on (year, month, day) in `timeZone`,
 * computed via `Intl.DateTimeFormat` offset parts rather than a fixed offset
 * addition — the fixed-offset approach breaks across a DST transition (a
 * period boundary that lands on/near a DST change would be off by an hour).
 *
 * Approach: format a UTC guess (the wall-clock time interpreted as UTC) in
 * the target zone, read back what that zone thinks the wall-clock is, and
 * correct the guess by the difference. One correction pass is sufficient
 * because IANA zone offsets change by at most a small number of hours at any
 * one transition, and midnight is never within an hour of two transitions.
 */
function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  return zonedWallClockUtc(year, month, day, 0, 0, 0, timeZone);
}

function zonedWallClockUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  // Initial guess: treat the requested wall-clock fields as if they were UTC.
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(new Date(guess));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // formatToParts renders 24:00 as "24" for midnight under hour12:false in
  // some engines; normalize to 0 for the same wall-clock day.
  const observedHour = get('hour') % 24;
  const observedAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), observedHour, get('minute'), get('second'));

  // The zone's local wall-clock (observedAsUtc, read as if it were UTC) for
  // instant `guess` differs from `guess` itself by the zone's offset. Shifting
  // `guess` by the NEGATIVE of that difference yields the instant whose
  // wall-clock in the zone is the ORIGINAL target fields.
  const diff = observedAsUtc - guess;
  return new Date(guess - diff);
}

function partsInZone(date: Date, timeZone: string): { year: number; month: number; day: number; weekday: string } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: get('weekday'),
  };
}

function parseDateOnly(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function resolveLastFullMonth(timeZone: string, now: Date): ResolvedReportPeriod {
  const { year, month } = partsInZone(now, timeZone);
  // Previous calendar month relative to `now`'s zoned month.
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const nextMonth = month; // the month AFTER prevMonth is the current month
  const nextYear = year;
  const start = zonedMidnightUtc(prevYear, prevMonth, 1, timeZone);
  const end = zonedMidnightUtc(nextYear, nextMonth, 1, timeZone);
  return {
    start,
    end,
    label: `${MONTH_NAMES[prevMonth - 1]} ${prevYear}`,
    timeZone,
    kind: 'last_full_month',
  };
}

function resolveLast30Days(timeZone: string, now: Date): ResolvedReportPeriod {
  const { year, month, day } = partsInZone(now, timeZone);
  const end = zonedMidnightUtc(year, month, day, timeZone);
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { start, end, label: 'Last 30 days', timeZone, kind: 'last_30_days' };
}

function resolveLastQuarter(timeZone: string, now: Date): ResolvedReportPeriod {
  const { year, month } = partsInZone(now, timeZone);
  const currentQuarter = Math.floor((month - 1) / 3); // 0-3
  const prevQuarter = currentQuarter === 0 ? 3 : currentQuarter - 1;
  const prevQuarterYear = currentQuarter === 0 ? year - 1 : year;
  const startMonth = prevQuarter * 3 + 1;
  const nextQuarterStartMonth = startMonth + 3; // may be 13 -> next year
  const endYear = nextQuarterStartMonth > 12 ? prevQuarterYear + 1 : prevQuarterYear;
  const endMonth = nextQuarterStartMonth > 12 ? nextQuarterStartMonth - 12 : nextQuarterStartMonth;
  const start = zonedMidnightUtc(prevQuarterYear, startMonth, 1, timeZone);
  const end = zonedMidnightUtc(endYear, endMonth, 1, timeZone);
  return {
    start,
    end,
    label: `Q${prevQuarter + 1} ${prevQuarterYear}`,
    timeZone,
    kind: 'last_quarter',
  };
}

function resolveCustom(input: ReportPeriodInput, timeZone: string, now: Date): ResolvedReportPeriod {
  const startParts = input.start ? parseDateOnly(input.start) : null;
  const endParts = input.end ? parseDateOnly(input.end) : null;
  if (!startParts || !endParts) {
    return resolveLastFullMonth(timeZone, now);
  }
  const start = zonedMidnightUtc(startParts.year, startParts.month, startParts.day, timeZone);
  // End is the NEXT midnight after the inclusive end date the user typed, so
  // the window is [start, end) and fully covers the last day.
  const endExclusiveDay = new Date(Date.UTC(endParts.year, endParts.month - 1, endParts.day + 1));
  const end = zonedMidnightUtc(
    endExclusiveDay.getUTCFullYear(),
    endExclusiveDay.getUTCMonth() + 1,
    endExclusiveDay.getUTCDate(),
    timeZone,
  );
  if (end.getTime() <= start.getTime()) {
    return resolveLastFullMonth(timeZone, now);
  }
  return {
    start,
    end,
    label: `${input.start} to ${input.end}`,
    timeZone,
    kind: 'custom',
  };
}

/**
 * Resolve a report's window in `timeZone` (the report OWNER's resolved
 * timezone — org -> partner -> UTC, per `resolveReportOwnerTimezone` below —
 * never the server's, spec §3.3 R1/R3). `[start, end)` — end is EXCLUSIVE
 * everywhere.
 */
export function resolveReportPeriod(
  input: ReportPeriodInput | undefined,
  timeZone: string,
  now: Date,
): ResolvedReportPeriod {
  const zone = safeTimezone(timeZone);
  const kind = input?.kind ?? 'last_full_month';
  switch (kind) {
    case 'last_30_days':
      return resolveLast30Days(zone, now);
    case 'last_quarter':
      return resolveLastQuarter(zone, now);
    case 'custom':
      return resolveCustom(input ?? { kind: 'custom' }, zone, now);
    case 'last_full_month':
    default:
      return resolveLastFullMonth(zone, now);
  }
}

/**
 * Count Mon-Fri days in `[start, end)`, evaluated in `timeZone`. Public
 * holidays are not modelled — an explicitly approximate capacity figure
 * (spec §3.3 R2), disclosed on the artifact rather than hidden.
 */
export function workingDaysBetween(start: Date, end: Date, timeZone: string): number {
  const zone = safeTimezone(timeZone);
  if (end.getTime() <= start.getTime()) return 0;

  let count = 0;
  let cursor = start;
  // Advance one zoned calendar day at a time. Using a fixed 24h increment
  // would misalign across a DST transition; instead step from the zoned
  // midnight of the current day to the zoned midnight of the next day.
  while (cursor.getTime() < end.getTime()) {
    const { year, month, day, weekday } = partsInZone(cursor, zone);
    if (weekday !== 'Sat' && weekday !== 'Sun') {
      count += 1;
    }
    const nextDayUtcGuess = new Date(Date.UTC(year, month - 1, day + 1));
    cursor = zonedMidnightUtc(
      nextDayUtcGuess.getUTCFullYear(),
      nextDayUtcGuess.getUTCMonth() + 1,
      nextDayUtcGuess.getUTCDate(),
      zone,
    );
  }
  return count;
}

/**
 * org -> partner -> UTC for an org owner; partner -> UTC for a partner owner.
 * Same chain as the schedule worker's `timezoneFor`, reusing
 * `resolveOrgTimezone` / `resolvePartnerTimezone` (`portal/timezone.ts`)
 * rather than a second inline `partners` select (#3198 W02 ruling P20).
 *
 * Both branches run through `runInReportScope` (ruling P6): on the request
 * path this asserts the ambient DB context can already see the owner's
 * scope and runs inside it; with no ambient context (worker path) it opens a
 * system context. Neither branch ever calls `runOutsideDbContext` — escaping
 * an ambient request transaction to open a second pooled connection is the
 * exact pattern that caused the #1105/#2417/09-22 pool double-hold
 * incidents.
 *
 * Note (drift report §4 Task 6): for an org owner reached under an ambient
 * ORG-scope context (the normal request path), `resolveOrgTimezone`'s
 * left-join to `partners` is invisible to that context under partner RLS, so
 * the partner half of the chain silently falls back to org settings/UTC. A
 * partner-scoped or system context sees the partner row. This means a
 * request-time org report and a worker-run org report can resolve to
 * different timezones when the org itself has no `settings.timezone` but its
 * partner does — a pre-existing property of `resolveOrgTimezone`, not
 * something this function changes.
 */
export async function resolveReportOwnerTimezone(owner: ReportOwner): Promise<string> {
  if (owner.orgId !== undefined) {
    const orgId = owner.orgId;
    return runInReportScope(organizationScope(orgId), () => resolveOrgTimezone(orgId));
  }
  const partnerId = owner.partnerId;
  return runInReportScope({ kind: 'partner', partnerId }, () => resolvePartnerTimezone(partnerId));
}
