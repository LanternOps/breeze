import { validateRevision, type BusinessCalendarDto } from '@breeze/shared';

// Editor-side model for the weekly business-hours grid (#8973). The API speaks
// minutes-from-midnight intervals; the grid edits "HH:MM" strings so a half-typed
// value never has to be a valid number.

export type IntervalDraft = { start: string; end: string };
/** Index = weekday, 0 = Sunday … 6 = Saturday. */
export type WeekDraft = IntervalDraft[][];

export type WeekProblem = 'invalidTime' | 'order' | 'overlap' | 'empty' | 'timezone';

/** Display order of the weekday rows: Monday first, Sunday last. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export function emptyWeek(): WeekDraft {
  return [[], [], [], [], [], [], []];
}

export function defaultWeek(): WeekDraft {
  const week = emptyWeek();
  for (const d of [1, 2, 3, 4, 5]) week[d] = [{ start: '09:00', end: '17:00' }];
  return week;
}

export function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 'HH:MM' → minutes; '24:00' is accepted only as an end-of-day value. */
export function parseMinute(value: string, isEnd: boolean): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (m > 59) return null;
  if (h === 24 && m === 0) return isEnd ? 1440 : null;
  if (h > 23) return null;
  return h * 60 + m;
}

export function weekFromCalendar(calendar: BusinessCalendarDto | null): WeekDraft {
  const week = emptyWeek();
  for (const i of calendar?.currentRevision?.intervals ?? []) {
    week[i.weekday]?.push({ start: formatMinute(i.startMinute), end: formatMinute(i.endMinute) });
  }
  for (const day of week) day.sort((a, b) => a.start.localeCompare(b.start));
  return week;
}

export type WeekResult =
  | { ok: true; intervals: { weekday: number; startMinute: number; endMinute: number }[] }
  | { ok: false; problem: WeekProblem };

/** Parse + validate the grid; overlap / emptiness / zone checks reuse the API's own validator. */
export function weekToIntervals(week: WeekDraft, timezone: string): WeekResult {
  const intervals: { weekday: number; startMinute: number; endMinute: number }[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (const row of week[weekday] ?? []) {
      const startMinute = parseMinute(row.start, false);
      const endMinute = parseMinute(row.end, true);
      if (startMinute === null || endMinute === null) return { ok: false, problem: 'invalidTime' };
      if (startMinute >= endMinute) return { ok: false, problem: 'order' };
      intervals.push({ weekday, startMinute, endMinute });
    }
  }
  const result = validateRevision({
    timezone,
    intervals: intervals as Parameters<typeof validateRevision>[0]['intervals'],
  });
  if (result.ok) return { ok: true, intervals };
  switch (result.code) {
    case 'NO_INTERVALS': return { ok: false, problem: 'empty' };
    case 'OVERLAP': return { ok: false, problem: 'overlap' };
    case 'BAD_TIMEZONE': return { ok: false, problem: 'timezone' };
    default: return { ok: false, problem: 'invalidTime' };
  }
}
