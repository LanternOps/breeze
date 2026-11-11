/**
 * Wall-clock time in an IANA timezone, with no dependency on anything else, so a
 * job, a route and a pure planner can all share one DST rule. Lifted from
 * jobs/patchSchedulerWorker.ts (#11065).
 */

export interface LocalTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
}

// Building a formatter is by far the expensive part, and a scheduler asks for the
// same few zones thousands of times a tick. Only valid zones get in, so the map is
// bounded by the IANA list.
const formatters = new Map<string, Intl.DateTimeFormat>();

function buildFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
}

function formatterFor(timezone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(timezone);
  if (cached) return cached;
  try {
    const built = buildFormatter(timezone);
    formatters.set(timezone, built);
    return built;
  } catch {
    return null;
  }
}

/** The zone as given when it is valid, otherwise UTC, and it says so. */
export function normalizeTimezone(timezone: string | null | undefined): string {
  const candidate = timezone || 'UTC';
  if (formatterFor(candidate)) return candidate;
  console.warn(`[zonedTime] Invalid timezone "${candidate}", falling back to UTC`);
  return 'UTC';
}

export function getLocalTimeParts(now: Date, timezone: string): LocalTimeParts {
  const parts = formatterFor(normalizeTimezone(timezone))!.formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '0';
  const weekday = get('weekday').toLowerCase().slice(0, 3) as LocalTimeParts['weekday'];

  return {
    year: Number.parseInt(get('year'), 10),
    month: Number.parseInt(get('month'), 10),
    day: Number.parseInt(get('day'), 10),
    hour: Number.parseInt(get('hour'), 10),
    minute: Number.parseInt(get('minute'), 10),
    second: Number.parseInt(get('second'), 10),
    weekday,
  };
}

/** The zone's UTC offset (ms) in force at `instant`. */
function zoneOffsetMsAt(instant: number, timezone: string): number {
  const local = getLocalTimeParts(new Date(instant), timezone);
  return (
    Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0) - instant
  );
}

/**
 * The UTC instant of a wall-clock time in `timezone`.
 *
 * Deliberately NOT a convergence loop. The naive guess uses the offset in force
 * at `wallAsUtc`, which is the wrong offset for a wall clock on the far side of
 * a DST transition; correcting once and re-checking is right for every ordinary
 * time, but on a SPRING-FORWARD day the requested wall clock does not exist at
 * all (02:00 is skipped) and the two candidates oscillate forever — a loop
 * settles on 01:00, an hour BEFORE the window the admin asked for.
 *
 * So: try the correction, accept it if the offset it implies is self-consistent,
 * and otherwise take the later of the two candidates — the same "shift forward
 * into the gap" rule Luxon and date-fns-tz use. An ambiguous fall-back time
 * resolves to one instant: either way, never two.
 */
export function zonedWallClockToUtc(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): Date {
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);

  const firstOffset = zoneOffsetMsAt(wallAsUtc, timezone);
  const firstCandidate = wallAsUtc - firstOffset;

  const secondOffset = zoneOffsetMsAt(firstCandidate, timezone);
  if (secondOffset === firstOffset) return new Date(firstCandidate);

  const secondCandidate = wallAsUtc - secondOffset;
  if (zoneOffsetMsAt(secondCandidate, timezone) === secondOffset) {
    return new Date(secondCandidate);
  }

  return new Date(Math.max(firstCandidate, secondCandidate));
}
