// Shared margin/markup helpers for the distributor catalog-import panels.
// "Margin" in Breeze's catalog is stored as `markupPercent` (markup OVER COST),
// so the default applies as a markup. We surface BOTH figures in the UI so the
// number is unambiguous when adding an item:
//   markup% = profit / cost   (drives the sell price from cost)
//   margin% = profit / price  (share of revenue that is profit)

import { formatNumber, formatPercent } from '@/lib/i18n/format';

export interface MarginBreakdown {
  cost: number;
  price: number;
  profit: number;
  /** (price - cost) / cost * 100 — matches the catalog `markupPercent` field. */
  markupPct: number;
  /** (price - cost) / price * 100 — gross margin as a share of the sell price. */
  marginPct: number;
}

/** Sell price implied by a cost + markup% (markup over cost), rounded to cents. */
export function priceFromCostMarkup(cost: number, markupPct: number): number {
  return Number((cost * (1 + markupPct / 100)).toFixed(2));
}

/** Live margin breakdown from a cost + sell price; null if either is missing. */
export function computeMarginBreakdown(cost: number | null, price: number | null): MarginBreakdown | null {
  if (cost === null || price === null || !Number.isFinite(cost) || !Number.isFinite(price)) return null;
  const profit = price - cost;
  const markupPct = cost > 0 ? (profit / cost) * 100 : 0;
  const marginPct = price > 0 ? (profit / price) * 100 : 0;
  return { cost, price, profit, markupPct, marginPct };
}

/** Format a margin breakdown as a one-line summary, e.g.
 *  "Margin 22.6% · Markup 29.2% · Profit USD 30.00". */
export function formatMarginSummary(b: MarginBreakdown, currency = 'USD'): string {
  return `Margin ${formatPercent(b.marginPct / 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} · Markup ${formatPercent(b.markupPct / 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} · Profit ${currency} ${formatNumber(b.profit, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Normalize a distributor feed's currency to a trimmed, uppercase ISO code.
 * `null` stays `null` — the import route schemas validate `product.currency`
 * as `currencyCodeSchema.nullable()` (NOT optional), so the key must be
 * present and explicitly null when the feed gave none; `undefined` would be
 * dropped by JSON serialization and the request would 400 (multi-currency
 * wave 3). Never substitutes `'USD'`.
 */
export function feedCurrencyCode(value: string | null | undefined): string | null {
  const code = (value ?? '').trim().toUpperCase();
  return code.length > 0 ? code : null;
}

/**
 * Whether a cost in `feedCurrency` may be compared against a sell price in
 * `partnerCurrency`. Margin math is only meaningful when both sides are in
 * the same currency (no conversion, ever). A feed that reports no currency is
 * assumed to be in the partner currency — the same default the API applies
 * when it derives `costCurrency` from `product.currency`.
 */
export function marginGuard(feedCurrency: string | null, partnerCurrency: string): boolean {
  const feed = feedCurrencyCode(feedCurrency);
  if (feed === null) return true;
  return feed === partnerCurrency.trim().toUpperCase();
}

/**
 * Strict same-currency check for the QUOTE editor lookups: a distributor feed
 * number (suggested retail, MSRP, cost) may only be prefilled into — or
 * compared against — a sell price in `targetCurrency` when the feed carries an
 * explicit, equal ISO code. A feed with no currency is UNKNOWN, never assumed:
 * copying a foreign or unknown-currency number into a field the caller then
 * stamps with the quote currency would silently relabel it (review #3).
 */
export function feedMatchesCurrency(feedCurrency: string | null | undefined, targetCurrency: string): boolean {
  const feed = feedCurrencyCode(feedCurrency);
  return feed !== null && feed === feedCurrencyCode(targetCurrency);
}
