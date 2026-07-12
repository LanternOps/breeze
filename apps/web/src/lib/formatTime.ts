import { resolvedFormattingLocale } from './i18n/format';
import { formatDate } from './dateTimeFormat';

export function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
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
