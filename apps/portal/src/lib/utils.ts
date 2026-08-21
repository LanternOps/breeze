import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(num: number): string {
  return new Intl.NumberFormat().format(num);
}

export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/** Whole calendar days between two dates, ignoring the time of day, so
 *  "Yesterday" stays correct for something that happened at 11pm and is read
 *  at 7am (a raw hour difference would call that "8 hours ago"). */
function calendarDaysAgo(from: Date, now: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

/**
 * Human phrasing for "when did this happen", written for the portal's audience:
 * business customers who visit a few times a year, not technicians. Full words
 * ("3 days ago", "Yesterday", "Last Tuesday") rather than the technician
 * shorthand ("3d ago", "17h ago") this used to emit.
 *
 * Signature is unchanged: takes a Date or an ISO string, returns a display string.
 * An unparseable value returns '' so a caller never prints "Invalid Date".
 */
export function formatRelativeTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '';

  const now = new Date();
  const diffSec = Math.floor((now.getTime() - d.getTime()) / 1000);
  // Future timestamps (clock skew on an agent check-in) read as "Just now"
  // rather than a negative count.
  if (diffSec < 60) return 'Just now';

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return plural(diffMin, 'minute');

  const days = calendarDaysAgo(d, now);
  if (days === 0) return plural(Math.floor(diffMin / 60), 'hour');
  if (days === 1) return 'Yesterday';
  // Inside the last week the weekday is the fastest thing to read.
  if (days < 7) return `Last ${d.toLocaleDateString('en-US', { weekday: 'long' })}`;

  return formatDate(d);
}

/**
 * Canonical short date for the portal's document surfaces (invoice/quote header
 * dates, list columns). Accepts a date-only string ('2026-08-21'), a full
 * timestamp, or null.
 *
 * Null/empty renders as '—' (an em dash placeholder, not user-facing prose) so a
 * missing date reads as "nothing here" instead of a silently blank cell. A
 * date-only string is pinned to local midnight so it never renders as the day
 * before in a negative-offset timezone. An unparseable value is echoed back
 * verbatim, which is more useful to support than 'Invalid Date'.
 *
 * This is the SSOT: five components carry private copies that disagree with each
 * other (PublicQuoteView returns '' for null; the rest return '—'). Migrate them
 * onto this one.
 */
export function shortDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '—' : value.toLocaleDateString();
  }
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}

/**
 * Canonical currency formatter for the portal. Amounts arrive from the API as
 * decimal strings, so this takes string | number and coerces once.
 *
 * A non-numeric amount formats as zero rather than 'NaN' — a customer-facing
 * total must never render as garbage. An unknown/invalid currency code falls
 * back to a plain two-decimal amount plus the code, since Intl throws on codes
 * it does not recognise.
 */
export function money(value: string | number, currencyCode: string): string {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  try {
    return safe.toLocaleString('en-US', { style: 'currency', currency: currencyCode || 'USD' });
  } catch {
    return `${safe.toFixed(2)} ${currencyCode || ''}`.trim();
  }
}

export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

export function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}
