import type { TimeEntry } from '../../services/timeEntries';

/**
 * What the timesheet should be showing right now.
 *
 * Pulled out of the screen because the defect it fixes is invisible in the
 * screen: entries fetched for the PREVIOUS week survived a failed load of the
 * new one, so `entries !== null` kept the error branch unreachable while
 * `buildLocalWeek` filtered every stale row out. The result was a confident
 * empty week with a 0m total where the truth was "the request failed" — the
 * worst possible rendering of a network error on a billing surface.
 */

export interface LoadedWeek {
  week: string;
  entries: TimeEntry[];
}

/** Entries only count for the week they were actually fetched for. */
export function entriesForWeek(loaded: LoadedWeek | null, weekStart: string): TimeEntry[] | null {
  return loaded !== null && loaded.week === weekStart ? loaded.entries : null;
}

export type TimesheetPhase = 'spinner' | 'error' | 'week';

export function timesheetPhase(input: {
  loading: boolean;
  loadError: string | null;
  entries: readonly TimeEntry[] | null;
}): TimesheetPhase {
  // Data for THIS week wins: a failed refresh over a week already on screen
  // keeps the rows and shows the failure as a banner rather than blanking them.
  if (input.entries !== null) return 'week';
  if (input.loading) return 'spinner';
  return input.loadError === null ? 'week' : 'error';
}
