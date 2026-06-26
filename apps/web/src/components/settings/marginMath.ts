// Shared margin/markup helpers for the distributor catalog-import panels.
// "Margin" in Breeze's catalog is stored as `markupPercent` (markup OVER COST),
// so the default applies as a markup. We surface BOTH figures in the UI so the
// number is unambiguous when adding an item:
//   markup% = profit / cost   (drives the sell price from cost)
//   margin% = profit / price  (share of revenue that is profit)

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
  return `Margin ${b.marginPct.toFixed(1)}% · Markup ${b.markupPct.toFixed(1)}% · Profit ${currency} ${b.profit.toFixed(2)}`;
}
