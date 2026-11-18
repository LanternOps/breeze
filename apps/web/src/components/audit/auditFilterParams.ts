/**
 * Query-param builders shared by the Audit Trail list/search request and the
 * CSV export (#8366), kept apart from the component so they can be unit-tested.
 */

export type DatePreset = 'today' | '7d' | '30d' | 'custom';

export type ActiveFilters = {
  datePreset: DatePreset;
  startDate?: string;
  endDate?: string;
  userId?: string;
  userEmail?: string;
  actions: string[];
  resources: string[];
  search: string;
};

const DATE_INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Start (00:00:00.000) or end (23:59:59.999) of a `<input type="date">` value
 * ("YYYY-MM-DD") in the browser's local zone (#9670). `new Date('YYYY-MM-DD')`
 * parses a date-only string as UTC midnight, which shifts the window by the
 * UTC offset. Anything that is not a real calendar date yields an Invalid Date,
 * so `toISOString()` throws and the caller's error path runs (the export toast)
 * instead of silently rolling "2026-02-30" over into March.
 */
function localDayBound(value: string, edge: 'start' | 'end'): Date {
  const match = DATE_INPUT_RE.exec(value);
  if (!match) return new Date(Number.NaN);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = edge === 'start'
    ? new Date(year, month - 1, day, 0, 0, 0, 0)
    : new Date(year, month - 1, day, 23, 59, 59, 999);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return new Date(Number.NaN);
  }
  return date;
}

export function computeDateRange(filters: ActiveFilters): { from?: string; to?: string } {
  const now = new Date();
  const to = now.toISOString();
  switch (filters.datePreset) {
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { from: start.toISOString(), to };
    }
    case '7d': {
      const start = new Date(now);
      start.setDate(start.getDate() - 7);
      return { from: start.toISOString(), to };
    }
    case '30d': {
      const start = new Date(now);
      start.setDate(start.getDate() - 30);
      return { from: start.toISOString(), to };
    }
    case 'custom': {
      // Inclusive local-day bounds, sent to the API as UTC instants.
      const result: { from?: string; to?: string } = {};
      if (filters.startDate) result.from = localDayBound(filters.startDate, 'start').toISOString();
      if (filters.endDate) result.to = localDayBound(filters.endDate, 'end').toISOString();
      return result;
    }
    default:
      return {};
  }
}

/** The filter query params shared by the list/search request and the export (#8366). */
export function appendFilterParams(params: URLSearchParams, filters: ActiveFilters | null): void {
  if (!filters) return;
  const { from, to } = computeDateRange(filters);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  // A user picked from the list is matched by identity (actor_id), which also
  // covers rows written without an actor email, such as agent.command.* (#9671).
  // The email text match is only the fallback when no id is known.
  if (filters.userId) params.set('userId', filters.userId);
  else if (filters.userEmail) params.set('user', filters.userEmail);
  if (filters.actions.length > 0) params.set('action', filters.actions.join(','));
  if (filters.resources.length > 0) params.set('resource', filters.resources.join(','));
  if (filters.search) params.set('q', filters.search);
}

export function hasActiveFilters(filters: ActiveFilters | null): boolean {
  if (!filters) return false;
  return !!(
    filters.userId ||
    filters.userEmail ||
    filters.actions.length > 0 ||
    filters.resources.length > 0 ||
    filters.search
  );
}
