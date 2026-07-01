// Shared money/date formatters for the billing surfaces (invoices, quotes,
// contracts). These are the canonical copies — `invoiceTypes.ts` and
// `quoteTypes.ts` re-export them so existing `./invoiceTypes` / `./quoteTypes`
// import sites keep working, and the contracts components import them directly
// (replacing two hand-rolled `formatDate` copies that had drifted).
//
// Money fields arrive from the API as numeric(12,2) *dollar* strings
// (e.g. '123.40') — these format dollars, NOT cents.

/** Currency-aware money formatter (invoices/quotes/contracts carry their own
 *  currencyCode, unlike the USD-only lib/timeFormat.formatMoney). */
export function formatMoney(value: string | number | null | undefined, currencyCode = 'USD'): string {
  const n = typeof value === 'number' ? value : Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  try {
    return safe.toLocaleString('en-US', { style: 'currency', currency: currencyCode || 'USD' });
  } catch {
    // Unknown/invalid currency code → fall back to plain 2-decimal + code suffix.
    return `${safe.toFixed(2)} ${currencyCode || ''}`.trim();
  }
}

/** Render an ISO date (YYYY-MM-DD or timestamp) as a short locale date, '—' if absent. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}
