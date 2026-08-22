// Shared money/date formatters for the billing surfaces (invoices, quotes,
// contracts). These are the canonical copies — `invoiceTypes.ts` and
// `quoteTypes.ts` re-export them so existing `./invoiceTypes` / `./quoteTypes`
// import sites keep working, and the contracts components import them directly
// (replacing two hand-rolled `formatDate` copies that had drifted).
//
// Money fields arrive from the API as numeric(12,2) *dollar* strings
// (e.g. '123.40') — these format dollars, NOT cents.

import { formatMoney as sharedFormatMoney } from '@breeze/shared';
import { resolvedFormattingLocale } from '@/lib/i18n/format';

/** Currency-aware money formatter — the web's single entry point onto the
 *  shared `@breeze/shared` `formatMoney` (multi-currency spec §9), rendered in
 *  the console's resolved locale. Every money surface (billing documents,
 *  ticketing, catalog) formats through here; an unknown/invalid currency code
 *  falls back to a plain 2-decimal amount + uppercased code suffix. */
export function formatMoney(value: string | number | null | undefined, currencyCode = 'USD'): string {
  return sharedFormatMoney(value, currencyCode || 'USD', resolvedFormattingLocale());
}

/** Sum money amounts grouped by currency, preserving first-seen order.
 *  Amounts are *dollars* (the same units `formatMoney` and the list-row money
 *  fields use), NOT cents. The list summary strips use this to render honest
 *  per-currency totals when rows span more than one currency, instead of
 *  labeling a mixed-currency sum with a single (wrong) currency code. Empty
 *  input → []; a single currency → one entry (renders exactly as before). */
export function sumByCurrency(
  entries: { amount: number; currencyCode: string }[],
): { code: string; amount: number }[] {
  const order: string[] = [];
  const totals = new Map<string, number>();
  for (const { amount, currencyCode } of entries) {
    const code = currencyCode || 'USD';
    if (!totals.has(code)) order.push(code);
    totals.set(code, (totals.get(code) ?? 0) + amount);
  }
  return order.map((code) => ({ code, amount: totals.get(code) ?? 0 }));
}

/** Render an ISO date (YYYY-MM-DD or timestamp) as a short locale date, '—' if absent. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}
