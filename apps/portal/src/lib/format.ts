/**
 * Shared customer-facing formatters. These were duplicated verbatim in four
 * list/detail components; one definition keeps the register's figures in one
 * voice. (quoteBlocks.tsx keeps its own exported `money` for the paper world's
 * per-line rendering — it re-exports this one.)
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

/** Date-only strings render calendar-true (no timezone shift); anything else
 *  falls back to the raw value rather than "Invalid Date". */
export function shortDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}
