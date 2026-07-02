/**
 * Report schedule occurrence math. Shared between the API's report-schedule
 * worker (which needs the *last* due occurrence to decide whether to enqueue
 * a run) and the web UI (which needs the *next* occurrence to show "Next: ...").
 */

// ─── Occurrence math ─────────────────────────────────────────────────────────
// All comparisons happen in wall-clock space for the report's timezone, encoded
// as a sortable number (YYYYMMDDHHmm). This avoids DST/offset conversions: a
// "daily at 09:00" report is due once the org's local clock passes 09:00,
// whatever UTC instant that is.

export type ScheduleCadence = 'daily' | 'weekly' | 'monthly';

export type ScheduleConfig = {
  /** 24h "HH:MM"; defaults to 09:00 (the builder's default). */
  time?: string;
  /** Weekly: lowercase weekday name; defaults to monday. */
  day?: string;
  /** Monthly: day-of-month "1".."31" (clamped to month length); defaults to 1. */
  date?: string;
};

const DAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

const WEEKDAY_SHORT_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

type WallClock = { y: number; m: number; d: number; hh: number; mm: number; weekday: number };

/** Decompose a UTC instant into wall-clock parts for a timezone. */
export function wallClockIn(instant: Date, timeZone: string): WallClock {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      weekday: 'short',
    }).formatToParts(instant);
  } catch {
    // Bad/unknown zone string in stored settings — fall back to UTC.
    return wallClockIn(instant, 'UTC');
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    hh: Number(get('hour')),
    mm: Number(get('minute')),
    weekday: WEEKDAY_SHORT_INDEX[get('weekday')] ?? 0,
  };
}

const keyOf = (y: number, m: number, d: number, hh: number, mm: number): number =>
  ((y * 100 + m) * 100 + d) * 10000 + hh * 100 + mm;

/** Pure calendar arithmetic (timezone-free): shift a Y/M/D by whole days. */
function shiftDays(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

function parseTime(time: string | undefined): { hh: number; mm: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time ?? '');
  const hh = match ? Number(match[1]) : 9;
  const mm = match ? Number(match[2]) : 0;
  if (!match || hh > 23 || mm > 59) return { hh: 9, mm: 0 };
  return { hh, mm };
}

/**
 * The most recent scheduled occurrence at or before `now`, as a wall-clock key
 * in `timeZone`. A report is due when its lastGeneratedAt (in the same
 * wall-clock space) predates this key.
 */
export function lastOccurrenceKey(
  now: Date,
  cadence: ScheduleCadence,
  cfg: ScheduleConfig,
  timeZone: string,
): number {
  const nowWc = wallClockIn(now, timeZone);
  const nowKey = keyOf(nowWc.y, nowWc.m, nowWc.d, nowWc.hh, nowWc.mm);
  const { hh, mm } = parseTime(cfg.time);

  if (cadence === 'daily') {
    let day = { y: nowWc.y, m: nowWc.m, d: nowWc.d };
    if (keyOf(day.y, day.m, day.d, hh, mm) > nowKey) day = shiftDays(day.y, day.m, day.d, -1);
    return keyOf(day.y, day.m, day.d, hh, mm);
  }

  if (cadence === 'weekly') {
    const target = DAY_INDEX[(cfg.day ?? 'monday').toLowerCase()] ?? 1;
    const delta = (nowWc.weekday - target + 7) % 7;
    let day = shiftDays(nowWc.y, nowWc.m, nowWc.d, -delta);
    if (keyOf(day.y, day.m, day.d, hh, mm) > nowKey) day = shiftDays(day.y, day.m, day.d, -7);
    return keyOf(day.y, day.m, day.d, hh, mm);
  }

  // monthly
  const wanted = Math.max(1, Math.min(31, Number(cfg.date) || 1));
  let y = nowWc.y;
  let m = nowWc.m;
  let d = Math.min(wanted, daysInMonth(y, m));
  if (keyOf(y, m, d, hh, mm) > nowKey) {
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
    d = Math.min(wanted, daysInMonth(y, m));
  }
  return keyOf(y, m, d, hh, mm);
}

/** Due when the report has never run, or last ran before the latest occurrence. */
export function isDue(
  lastGeneratedAt: Date | null,
  occurrenceKey: number,
  timeZone: string,
): boolean {
  if (!lastGeneratedAt) return true;
  const wc = wallClockIn(lastGeneratedAt, timeZone);
  return keyOf(wc.y, wc.m, wc.d, wc.hh, wc.mm) < occurrenceKey;
}

/**
 * The next scheduled occurrence strictly after `now`, as wall-clock parts in
 * `timeZone`. Forward mirror of lastOccurrenceKey — used by the web to show
 * "Next: Mon, Jul 6, 9:00 AM" without inverse-timezone math (the parts are
 * formatted directly, never converted back to an instant).
 */
export function nextOccurrence(
  now: Date,
  cadence: ScheduleCadence,
  cfg: ScheduleConfig,
  timeZone: string,
): { y: number; m: number; d: number; hh: number; mm: number } {
  const nowWc = wallClockIn(now, timeZone);
  const nowKey = keyOf(nowWc.y, nowWc.m, nowWc.d, nowWc.hh, nowWc.mm);
  const { hh, mm } = parseTime(cfg.time);

  if (cadence === 'daily') {
    let day = { y: nowWc.y, m: nowWc.m, d: nowWc.d };
    if (keyOf(day.y, day.m, day.d, hh, mm) <= nowKey) day = shiftDays(day.y, day.m, day.d, 1);
    return { ...day, hh, mm };
  }

  if (cadence === 'weekly') {
    const target = DAY_INDEX[(cfg.day ?? 'monday').toLowerCase()] ?? 1;
    const delta = (target - nowWc.weekday + 7) % 7;
    let day = shiftDays(nowWc.y, nowWc.m, nowWc.d, delta);
    if (keyOf(day.y, day.m, day.d, hh, mm) <= nowKey) day = shiftDays(day.y, day.m, day.d, 7);
    return { ...day, hh, mm };
  }

  // monthly
  const wanted = Math.max(1, Math.min(31, Number(cfg.date) || 1));
  let y = nowWc.y;
  let m = nowWc.m;
  let d = Math.min(wanted, daysInMonth(y, m));
  if (keyOf(y, m, d, hh, mm) <= nowKey) {
    m += 1;
    if (m === 13) { m = 1; y += 1; }
    d = Math.min(wanted, daysInMonth(y, m));
  }
  return { y, m, d, hh, mm };
}

/** Format wall-clock occurrence parts as a display label ("Mon, Jul 6, 9:00 AM").
 * The parts are already in the schedule's timezone, so format them as UTC to
 * avoid any further conversion. */
export function formatNextOccurrence(
  occ: { y: number; m: number; d: number; hh: number; mm: number },
  opts?: { weekday?: boolean },
): string {
  const instant = new Date(Date.UTC(occ.y, occ.m - 1, occ.d, occ.hh, occ.mm));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    ...(opts?.weekday ? { weekday: 'short' } : {}),
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(instant);
}
