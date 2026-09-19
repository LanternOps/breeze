/**
 * Pure cron-expression evaluation (5-field, zone-aware). Extracted from
 * automationRuntime.ts (#4141) so schedule-driven workers (discoveryWorker,
 * networkBaselineWorker via discovery, sensitiveDataJobs) can evaluate cron
 * windows without pulling in the automation runtime's import graph
 * (automationRuntime -> scriptDispatch -> routes/agentWs), which pinned them
 * to socket-owner placement in the worker registry. No imports on purpose.
 */
export function matchesCronField(
  field: string,
  value: number,
  min: number,
  max: number,
): boolean {
  const normalized = field.trim();

  if (normalized === '*') {
    return true;
  }

  const values = normalized.split(',');
  for (const segment of values) {
    const valueMatch = segment.trim();
    if (!valueMatch) continue;

    const stepParts = valueMatch.split('/');
    const base = stepParts[0] ?? '';
    const step = stepParts[1] ? Number.parseInt(stepParts[1], 10) : null;

    let rangeStart = min;
    let rangeEnd = max;

    if (base !== '*') {
      if (base.includes('-')) {
        const [startRaw, endRaw] = base.split('-');
        const parsedStart = Number.parseInt(startRaw ?? '', 10);
        const parsedEnd = Number.parseInt(endRaw ?? '', 10);
        if (Number.isNaN(parsedStart) || Number.isNaN(parsedEnd)) {
          continue;
        }
        rangeStart = parsedStart;
        rangeEnd = parsedEnd;
      } else {
        const parsedSingle = Number.parseInt(base, 10);
        if (Number.isNaN(parsedSingle)) {
          continue;
        }
        rangeStart = parsedSingle;
        rangeEnd = parsedSingle;
      }
    }

    if (value < rangeStart || value > rangeEnd) {
      continue;
    }

    if (!step || step <= 0) {
      return true;
    }

    if ((value - rangeStart) % step === 0) {
      return true;
    }
  }

  return false;
}

/**
 * One `Intl.DateTimeFormat` per zone, reused for the process lifetime (#4450).
 *
 * Constructing a formatter resolves and validates the zone against the whole
 * IANA database, which costs far more than formatting with it — and the fixed
 * 5-minute AI sweep tick asks `isCronDue` about EVERY candidate minute of a
 * 24 h lookback, per schedule (`services/aiAgents/sweepOccurrence.ts` walks
 * back one minute at a time). That is up to 1441 constructions per schedule
 * per tick, all for the same (zone, options) pair, so it grows with the
 * schedule count for no benefit. The options below depend on NOTHING but the
 * zone, and a formatter is immutable once built, so the zone is a complete
 * cache key.
 *
 * Bounded because the zone reaches here straight from a DB column: a row
 * carrying garbage must not be able to grow this without limit. Only
 * successfully constructed formatters are ever stored (an invalid zone throws
 * out of the constructor, exactly as before, and is retried rather than
 * remembered), and at the limit the map is dropped wholesale and rebuilt —
 * cheaper to reason about than an eviction order, and the pathological case it
 * protects against is one that degrades to the pre-memoisation behaviour, not
 * one that breaks.
 */
const FORMATTER_CACHE_LIMIT = 64;
const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

/** Test seam (#4450): drop the memoised zone formatters. */
export function resetCronDueFormatterCache(): void {
  zonedFormatters.clear();
}

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = zonedFormatters.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
    weekday: 'short',
  });

  if (zonedFormatters.size >= FORMATTER_CACHE_LIMIT) zonedFormatters.clear();
  zonedFormatters.set(timeZone, formatter);
  return formatter;
}

function getZonedDateParts(date: Date, timeZone: string): {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
} {
  const parts = zonedFormatter(timeZone).formatToParts(date);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));

  const weekday = lookup.get('weekday') ?? 'Sun';
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    minute: Number.parseInt(lookup.get('minute') ?? '0', 10),
    hour: Number.parseInt(lookup.get('hour') ?? '0', 10),
    dayOfMonth: Number.parseInt(lookup.get('day') ?? '1', 10),
    month: Number.parseInt(lookup.get('month') ?? '1', 10),
    dayOfWeek: weekdayMap[weekday] ?? 0,
  };
}

export function isCronDue(cronExpression: string, timeZone: string, date: Date = new Date()): boolean {
  const fields = cronExpression.trim().split(/\s+/);
  if (fields.length !== 5) {
    console.warn(`[CronDue] Invalid cron expression "${cronExpression}" (expected 5 fields, got ${fields.length})`);
    return false;
  }

  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = fields;
  const zoned = getZonedDateParts(date, timeZone);

  const minuteMatches = matchesCronField(minuteField ?? '*', zoned.minute, 0, 59);
  const hourMatches = matchesCronField(hourField ?? '*', zoned.hour, 0, 23);
  const monthMatches = matchesCronField(monthField ?? '*', zoned.month, 1, 12);

  const dayOfMonthMatches = matchesCronField(dayOfMonthField ?? '*', zoned.dayOfMonth, 1, 31);
  const normalizedDowValue = zoned.dayOfWeek === 0 ? 7 : zoned.dayOfWeek;
  const dayOfWeekMatches = matchesCronField(dayOfWeekField ?? '*', zoned.dayOfWeek, 0, 7)
    || matchesCronField(dayOfWeekField ?? '*', normalizedDowValue, 1, 7);

  const isDomWildcard = (dayOfMonthField ?? '*') === '*';
  const isDowWildcard = (dayOfWeekField ?? '*') === '*';

  const dayMatches = isDomWildcard || isDowWildcard
    ? dayOfMonthMatches && dayOfWeekMatches
    : dayOfMonthMatches || dayOfWeekMatches;

  return minuteMatches && hourMatches && monthMatches && dayMatches;
}
