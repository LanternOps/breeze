import { resolvedFormattingLocale } from './i18n/format';
import { formatDate } from './dateTimeFormat';

export function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  // Intl.RelativeTimeFormat.format(NaN) throws; an unparseable stamp must
  // degrade to a placeholder, never take the row (or the page) down.
  if (Number.isNaN(date.getTime())) return '—';
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  const locale = resolvedFormattingLocale();
  if (diffMins < 1) {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, 'second');
  }

  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  if (diffMins < 60) return formatter.format(-diffMins, 'minute');
  if (diffHours < 24) return formatter.format(-diffHours, 'hour');
  return formatter.format(-diffDays, 'day');
}

/**
 * Forward-looking sibling of `formatTimeAgo`: "in 3 days", "in 5 hours".
 *
 * Deadlines are the one place the console looks FORWARD, and neither existing
 * helper can express that — `formatTimeAgo` computes `now - date`, so a future
 * instant collapses to "now", and `formatRelativeTime` in `lib/utils.ts` is
 * past-only with hardcoded English strings. `Intl.RelativeTimeFormat` handles
 * the direction and the locale here, same as `formatTimeAgo`.
 *
 * Returns `null` — not a formatted string — for an unparseable stamp or an
 * instant that has already passed, so callers fall back to deadline-free copy
 * instead of printing "in 0 minutes" about a window that is already shut.
 *
 * `now` is injectable so tests can pin the clock without fake timers.
 */
export function formatTimeUntil(dateString: string, now?: Date): string | null {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return null;

  const diffMs = date.getTime() - (now ?? new Date()).getTime();
  if (diffMs <= 0) return null;

  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  const formatter = new Intl.RelativeTimeFormat(resolvedFormattingLocale(), {
    numeric: 'always',
  });
  // Floor at one minute rather than falling through to a "now" phrasing: the
  // window is still open, and saying "now" about an open deadline reads as
  // "too late".
  if (diffHours < 1) return formatter.format(Math.max(diffMins, 1), 'minute');
  if (diffDays < 1) return formatter.format(diffHours, 'hour');
  return formatter.format(diffDays, 'day');
}

/** Compact "last seen" format for tables: 5m ago, 3h ago, 2d ago, then absolute date */
export function formatLastSeen(dateString: string, timezone?: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  const relative = new Intl.RelativeTimeFormat(resolvedFormattingLocale(), {
    numeric: 'auto',
    style: 'short',
  });

  if (diffMins < 1) return relative.format(0, 'second');
  if (diffMins < 60) return relative.format(-diffMins, 'minute');
  if (diffHours < 24) return relative.format(-diffHours, 'hour');
  if (diffDays < 7) return relative.format(-diffDays, 'day');
  return formatDate(date, timezone ? { timeZone: timezone } : undefined);
}
