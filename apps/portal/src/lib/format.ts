import { formatCalendarDate, formatMoney } from '@breeze/shared';
import { portalLocale } from '@/lib/money';
/**
 * Shared customer-facing formatters. These were duplicated verbatim in four
 * list/detail components; one definition keeps the register's figures in one
 * voice.
 */

// Formatting itself is the multi-currency formatter in lib/money.ts (shared
// formatMoney in the browser's locale); this adds the guard above it so a
// broken figure reads as a dash, never as a settled-looking zero.
export function money(value: string | number, currencyCode: string): string {
  // Number(null) and Number('') are 0, which would dress a missing amount as a
  // settled one; only an actual numeric value may format.
  const n = value === null || value === undefined || value === '' ? NaN : Number(value);
  if (!Number.isFinite(n)) {
    // A figure that failed to parse must never read as "$0.00" on a bill —
    // that hides the bug behind a settled-looking balance. Show a dash and log.
    console.error('[portal] non-numeric money value', { value, currencyCode });
    return '—';
  }
  return formatMoney(n, currencyCode, portalLocale());
}

/** Date-only strings render calendar-true (no timezone shift); anything else
 *  falls back to the raw value rather than "Invalid Date".
 *
 *  A timestamp is an instant, and the day it falls on depends on the zone. On
 *  an SSR-only component the runtime zone is the server's (UTC in the
 *  container), on a hydrated one it is the customer's browser, so the same
 *  instant can print as two different days (#10291). Pass the org zone the API
 *  hands back (`timezone`, org → partner → UTC) and every surface agrees. */
export function shortDate(value: string | null | undefined, timeZone?: string): string {
  if (!value) return '—';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const d = new Date(dateOnly ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { timeZone: dateOnly ? 'UTC' : timeZone });
}

/** "November 4, 2026" in the customer's locale. Date-only values are calendar
 *  days (no timezone shift); timestamps render in the viewer's zone. */
export function longDate(value: string | null | undefined): string {
  return formatCalendarDate(value, portalLocale());
}
