import { multiplyToCurrency, toMinorUnits, fromMinorUnits } from '@breeze/shared';

/**
 * #9828 W3 — the TypeScript reference for the client-profitability invoice-line
 * fold (`invoiceLineFoldQuery`, businessReports/clientProfitabilityQueries.ts).
 * Test-only. The parity unit test proves it agrees with the invoice margin
 * panel (`computeQuoteProfit` via the `computeInvoiceProfit` mapping) and the
 * integration test proves the SQL fold agrees with it over real seeded lines,
 * so SQL ≡ reference ≡ panel, except where R4 deliberately differs (a bundle
 * with a NULL-cost component is unknown cost, spec T10).
 *
 * The contract (spec §3.1):
 *  - top-level (`parentLineId === null`) customer-visible lines only;
 *  - revenue = the stored line total = quantity × unit price rounded once at
 *    the currency's minor unit;
 *  - known cost ⇔ `costBasis !== null` and no child line of it has a NULL cost;
 *  - cost = Σ (quantity × costBasis rounded once per line) over known lines;
 *  - category, first match wins: block-overage contract line → labor,
 *    contract → recurring, time_entry → labor, part/catalog/bundle or a manual
 *    line carrying a catalog item → product, ai_usage → ai, else other.
 */
export type RevenueCategory = 'recurring' | 'labor' | 'product' | 'ai' | 'other';

export type ReferenceLine = {
  id: string;
  parentLineId: string | null;
  sourceType: 'time_entry' | 'part' | 'catalog' | 'bundle' | 'manual' | 'contract' | 'ai_usage';
  catalogItemId?: string | null;
  quantity: string;
  unitPrice: string;
  costBasis: string | null;
  customerVisible: boolean;
  /** Identified as hour-block overage (W1's `blockOverageLineIdsCte`). */
  blockOverage?: boolean;
};

export type ReferenceFoldTotals = {
  revenue: string;
  costBearingRevenue: string;
  cost: string;
  unknownCostRevenue: string;
  linesMissingCost: number;
  partialCostBundles: number;
};

export type ReferenceFold = ReferenceFoldTotals & { byCategory: Partial<Record<RevenueCategory, ReferenceFoldTotals>> };

export function categoryOf(l: ReferenceLine): RevenueCategory {
  if (l.sourceType === 'contract') return l.blockOverage ? 'labor' : 'recurring';
  if (l.sourceType === 'time_entry') return 'labor';
  if (l.sourceType === 'part' || l.sourceType === 'catalog' || l.sourceType === 'bundle') return 'product';
  if (l.sourceType === 'manual' && l.catalogItemId) return 'product';
  if (l.sourceType === 'ai_usage') return 'ai';
  return 'other';
}

type Acc = { revenue: number; costBearing: number; cost: number; missing: number; partial: number };
const emptyAcc = (): Acc => ({ revenue: 0, costBearing: 0, cost: 0, missing: 0, partial: 0 });

function totalsOf(a: Acc, currency: string): ReferenceFoldTotals {
  return {
    revenue: fromMinorUnits(a.revenue, currency),
    costBearingRevenue: fromMinorUnits(a.costBearing, currency),
    cost: fromMinorUnits(a.cost, currency),
    unknownCostRevenue: fromMinorUnits(a.revenue - a.costBearing, currency),
    linesMissingCost: a.missing,
    partialCostBundles: a.partial,
  };
}

/** Fold one currency's invoice lines (every line of the invoices, children included). */
export function referenceFold(lines: readonly ReferenceLine[], currency: string): ReferenceFold {
  const childMissingCost = new Set(
    lines.filter((l) => l.parentLineId !== null && l.costBasis === null).map((l) => l.parentLineId as string),
  );
  const total = emptyAcc();
  const byCategory = new Map<RevenueCategory, Acc>();
  for (const l of lines) {
    if (l.parentLineId !== null || !l.customerVisible) continue;
    const category = categoryOf(l);
    const acc = byCategory.get(category) ?? emptyAcc();
    byCategory.set(category, acc);
    const revenue = toMinorUnits(multiplyToCurrency(l.quantity, l.unitPrice, currency), currency);
    const partial = l.costBasis !== null && childMissingCost.has(l.id);
    const known = l.costBasis !== null && !partial;
    for (const a of [total, acc]) {
      a.revenue += revenue;
      if (known) {
        a.costBearing += revenue;
        a.cost += toMinorUnits(multiplyToCurrency(l.quantity, l.costBasis as string, currency), currency);
      } else {
        a.missing += 1;
      }
      if (partial) a.partial += 1;
    }
  }
  return {
    ...totalsOf(total, currency),
    byCategory: Object.fromEntries([...byCategory].map(([k, a]) => [k, totalsOf(a, currency)])),
  };
}
