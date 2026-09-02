import type { TimeEntry } from '../../services/timeEntries';

import { localMidnightMs as defaultLocalMidnightMs, shiftWeek } from './timesheetWeek';

/**
 * Re-files a fetched timesheet onto the technician's LOCAL calendar.
 *
 * The seam this closes: the client asks for a week derived from local calendar
 * fields (`timesheetWeek.ts`) and sends it as a date-only string, but
 * `timesheetQuerySchema` coerces that to UTC midnight, so `getTimesheet`
 * windows on `[weekStartUTC, +7d)` and buckets each row by
 * `startedAt.toISOString().slice(0,10)` — all UTC. The seven day-key STRINGS
 * coincide with the local ones, so the grid renders cleanly and nothing looks
 * broken; only the attribution is wrong. In America/New_York a Sunday 20:00
 * callout is stamped 00:00Z Monday, so it falls outside the requested window
 * entirely (missing from the rows AND the weekly total) and reappears the next
 * week filed under Monday with a "20:00" start label.
 *
 * The endpoint takes no timezone parameter, and this wave adds no API changes,
 * so the fix is client-side: fetch the adjacent server week that overlaps the
 * local one, bucket every entry by its own local day, and total what is
 * actually shown.
 *
 * Pure module: no React Native imports, so the local/UTC edge is unit-testable
 * with the zone pinned in vitest.config.ts (see the note there — a
 * `process.env.TZ` assignment inside a test file does NOT take effect under the
 * threads pool).
 */

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Local `YYYY-MM-DD` for an ISO timestamp, or null if it cannot be parsed. */
export function localDayKey(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Which neighbouring server week(s) also overlap the LOCAL week starting at
 * `weekStart`.
 *
 * Derived from the displayed week's own boundaries, never from today's UTC
 * offset. Those differ across a DST change: in Europe/London a July week starts
 * at 23:00Z the previous Sunday and needs the PREVIOUS server week, while a
 * January week aligns with UTC and needs none. Asking "what is the offset
 * today" therefore fetched the wrong neighbour — or none at all — for any week
 * on the other side of the change, and the boundary entries silently vanished
 * from both the rows and the weekly total.
 *
 * `localMidnightMs` is injectable so the DST behaviour is testable without an
 * ambient timezone.
 */
export function neighbourWeekOffsets(
  weekStart: string,
  localMidnightMs: (dateOnly: string) => number = defaultLocalMidnightMs
): Array<-1 | 1> {
  const serverStartMs = Date.parse(`${weekStart}T00:00:00.000Z`);
  if (Number.isNaN(serverStartMs)) return [];

  const localStartMs = localMidnightMs(weekStart);
  const localEndMs = localMidnightMs(shiftWeek(weekStart, 1));
  if (Number.isNaN(localStartMs) || Number.isNaN(localEndMs)) return [];

  const offsets: Array<-1 | 1> = [];
  if (localStartMs < serverStartMs) offsets.push(-1);
  if (localEndMs > serverStartMs + WEEK_MS) offsets.push(1);
  return offsets;
}

export interface LocalWeekView {
  byDay: Map<string, TimeEntry[]>;
  dayTotals: Map<string, number>;
  totals: { totalMinutes: number; billableMinutes: number };
}

/**
 * Buckets entries onto `days` (local `YYYY-MM-DD`), dropping anything outside
 * the local week and de-duplicating the overlap between the two fetches.
 *
 * Totals are recomputed from the entries actually shown rather than taken from
 * the server's UTC-windowed `totals`, which would disagree with the rows.
 */
export function buildLocalWeek(entries: readonly TimeEntry[], days: readonly string[]): LocalWeekView {
  const wanted = new Set(days);
  const seen = new Set<string>();
  const byDay = new Map<string, TimeEntry[]>();
  const dayTotals = new Map<string, number>();
  let totalMinutes = 0;
  let billableMinutes = 0;

  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    const day = localDayKey(entry.startedAt);
    if (day === null || !wanted.has(day)) continue;
    seen.add(entry.id);

    const bucket = byDay.get(day);
    if (bucket === undefined) byDay.set(day, [entry]);
    else bucket.push(entry);

    // A still-running entry has no duration yet; counting it as NaN would wipe
    // out the whole week's total.
    const minutes = entry.durationMinutes ?? 0;
    dayTotals.set(day, (dayTotals.get(day) ?? 0) + minutes);
    totalMinutes += minutes;
    if (entry.isBillable) billableMinutes += minutes;
  }

  for (const bucket of byDay.values()) {
    bucket.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  return { byDay, dayTotals, totals: { totalMinutes, billableMinutes } };
}
