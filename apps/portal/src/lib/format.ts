import { formatMoney } from '@breeze/shared';
import { portalLocale } from '@/lib/money';
/**
 * Shared customer-facing formatters. These were duplicated verbatim in four
 * list/detail components; one definition keeps the register's figures in one
 * voice. (quoteBlocks.tsx keeps its own exported `money` for the paper world's
 * per-line rendering — it re-exports this one.)
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
 *  falls back to the raw value rather than "Invalid Date". */
export function shortDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}
