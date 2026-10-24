import { describe, expect, it } from 'vitest';
import { computeLineTotal, computeQuoteProfit, marginPct, multiplyToCurrency, type QuoteLineForMath } from '@breeze/shared';
import { referenceFold, type ReferenceLine } from '../__testutils__/clientProfitabilityReferenceFold';

/**
 * #9828 W3 Task 3.1 — the client-profitability fold agrees with the invoice
 * margin panel, line for line (spec §3.1 "Parity"; plan Task 3.1 Step 1).
 *
 * The panel is `computeInvoiceProfit` (apps/web/src/components/billing/
 * invoiceTypes.ts): top-level lines only, mapped straight through to
 * `computeQuoteProfit` as one-time lines. `toPanelLines` below is that exact
 * mapping — the web module cannot be imported from the API, so the mapping is
 * restated and the shared math is called directly.
 *
 * Parity holds for 2-decimal currencies on revenue, cost, net, lines missing
 * cost, coverage and margin %. Two documented differences, each asserted so a
 * change on either side is noticed:
 *  - a bundle with a NULL-cost component (T10): R4 treats the parent as
 *    unknown cost; the panel trusts the parent's rollup (follow-up 2);
 *  - zero-decimal currencies: `computeQuoteProfit` rounds every line at USD
 *    precision (`computeLineTotal` default), the report at the currency's
 *    minor unit (follow-up 3).
 */

function toPanelLines(lines: readonly ReferenceLine[]): QuoteLineForMath[] {
  return lines
    .filter((l) => l.parentLineId === null)
    .map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      unitCost: l.costBasis,
      taxable: false,
      customerVisible: l.customerVisible,
      recurrence: 'one_time' as const,
    }));
}

/** What the panel shows, in the report's terms. */
function panel(lines: readonly ReferenceLine[]) {
  const mapped = toPanelLines(lines);
  const p = computeQuoteProfit(mapped);
  const revenueCents = mapped
    .filter((l) => l.customerVisible)
    .reduce((t, l) => t + Math.round(Number(computeLineTotal(l.quantity, l.unitPrice)) * 100), 0);
  const revenue = (revenueCents / 100).toFixed(2);
  const pct = marginPct(p.oneTimeNet, p.oneTimeRevenue);
  return {
    revenue,
    costBearingRevenue: p.oneTimeRevenue,
    cost: p.totalCost,
    net: p.oneTimeNet,
    linesMissingCost: p.linesMissingCost,
    coverage: revenueCents > 0 ? Number(p.oneTimeRevenue) / Number(revenue) : null,
    marginPct: pct === null ? null : pct / 100,
  };
}

/** The same figures from the reference fold (fractions, as the report prints them). */
function report(lines: readonly ReferenceLine[], currency = 'USD') {
  const f = referenceFold(lines, currency);
  const cb = Number(f.costBearingRevenue);
  const net = (Math.round(cb * 100) - Math.round(Number(f.cost) * 100)) / 100;
  return {
    revenue: f.revenue,
    costBearingRevenue: f.costBearingRevenue,
    cost: f.cost,
    net: net.toFixed(2),
    linesMissingCost: f.linesMissingCost,
    coverage: Number(f.revenue) > 0 ? cb / Number(f.revenue) : null,
    marginPct: cb > 0 ? net / cb : null,
  };
}

let seq = 0;
const line = (o: Partial<ReferenceLine> & Pick<ReferenceLine, 'quantity' | 'unitPrice' | 'costBasis'>): ReferenceLine => ({
  id: `l${++seq}`, parentLineId: null, sourceType: 'catalog', customerVisible: true, ...o,
});

const FIXTURES: Record<string, () => ReferenceLine[]> = {
  'plain catalog lines': () => [
    line({ quantity: '2.00', unitPrice: '120.00', costBasis: '80.00' }),
    line({ quantity: '1.00', unitPrice: '49.99', costBasis: '30.10' }),
  ],
  'visible-component bundle (T1: parent carries the whole cost, children their own)': () => {
    const parent = line({ sourceType: 'bundle', quantity: '1.00', unitPrice: '500.00', costBasis: '320.00' });
    return [
      parent,
      line({ parentLineId: parent.id, quantity: '1.00', unitPrice: '0.00', costBasis: '200.00' }),
      line({ parentLineId: parent.id, quantity: '2.00', unitPrice: '0.00', costBasis: '60.00' }),
    ];
  },
  'hidden line': () => [
    line({ quantity: '1.00', unitPrice: '100.00', costBasis: '40.00' }),
    line({ quantity: '1.00', unitPrice: '75.00', costBasis: null, customerVisible: false }),
  ],
  'all-labor invoice (T2: NULL cost is unknown, not zero)': () => [
    line({ sourceType: 'time_entry', quantity: '1.50', unitPrice: '95.00', costBasis: null }),
    line({ sourceType: 'time_entry', quantity: '0.25', unitPrice: '95.00', costBasis: null }),
  ],
  'explicit 0.00 cost is a known zero': () => [
    line({ sourceType: 'manual', quantity: '1.00', unitPrice: '150.00', costBasis: '0.00' }),
  ],
  'mixed known and unknown cost': () => [
    line({ quantity: '3.00', unitPrice: '10.00', costBasis: '6.00' }),
    line({ sourceType: 'contract', quantity: '1.00', unitPrice: '1000.00', costBasis: null }),
    line({ sourceType: 'ai_usage', quantity: '1.00', unitPrice: '12.34', costBasis: null }),
  ],
  'half-cent tie rounds half-up per line': () => [
    line({ quantity: '1.50', unitPrice: '0.03', costBasis: '0.01' }), // revenue 0.045 → 0.05, cost 0.015 → 0.02
    line({ quantity: '0.50', unitPrice: '0.05', costBasis: '0.03' }), // revenue 0.025 → 0.03, cost 0.015 → 0.02
  ],
};

describe('client profitability fold ≡ invoice margin panel (2-decimal currencies)', () => {
  it.each(Object.keys(FIXTURES))('%s', (name) => {
    const lines = FIXTURES[name]!();
    const r = report(lines);
    const p = panel(lines);
    expect(r.revenue).toBe(p.revenue);
    expect(r.costBearingRevenue).toBe(p.costBearingRevenue);
    expect(r.cost).toBe(p.cost);
    expect(r.net).toBe(p.net);
    expect(r.linesMissingCost).toBe(p.linesMissingCost);
    expect(r.coverage).toBeCloseTo(p.coverage ?? Number.NaN, 12);
    if (p.marginPct === null) expect(r.marginPct).toBeNull();
    else expect(r.marginPct).toBeCloseTo(p.marginPct, 12);
  });

  it('pins the fixtures that carry the spec traps', () => {
    const labor = report(FIXTURES['all-labor invoice (T2: NULL cost is unknown, not zero)']!());
    expect(labor).toMatchObject({ revenue: '166.25', costBearingRevenue: '0.00', cost: '0.00', coverage: 0, marginPct: null });
    const bundle = report(FIXTURES['visible-component bundle (T1: parent carries the whole cost, children their own)']!());
    expect(bundle).toMatchObject({ revenue: '500.00', cost: '320.00', net: '180.00' }); // never 320 + 200 + 120
    const tie = report(FIXTURES['half-cent tie rounds half-up per line']!());
    expect(tie).toMatchObject({ revenue: '0.08', cost: '0.04' });
  });
});

describe('documented differences', () => {
  it('a bundle with a NULL-cost component is unknown cost in R4 but costed by the panel (T10, follow-up 2)', () => {
    const parent = line({ sourceType: 'bundle', quantity: '1.00', unitPrice: '500.00', costBasis: '200.00' });
    const lines = [
      parent,
      line({ parentLineId: parent.id, quantity: '1.00', unitPrice: '0.00', costBasis: '200.00' }),
      line({ parentLineId: parent.id, quantity: '1.00', unitPrice: '0.00', costBasis: null }),
    ];
    const f = referenceFold(lines, 'USD');
    expect(f).toMatchObject({ revenue: '500.00', costBearingRevenue: '0.00', cost: '0.00', unknownCostRevenue: '500.00', linesMissingCost: 1, partialCostBundles: 1 });
    const p = panel(lines);
    expect(p).toMatchObject({ costBearingRevenue: '500.00', cost: '200.00', net: '300.00', linesMissingCost: 0 });
  });

  it('JPY: the fold rounds per line at 0 dp; computeQuoteProfit rounds at USD precision (follow-up 3)', () => {
    const lines = [line({ quantity: '0.50', unitPrice: '4.00', costBasis: '1.00' })];
    const f = referenceFold(lines, 'JPY');
    expect(f.revenue).toBe(multiplyToCurrency('0.50', '4.00', 'JPY'));
    expect(f.cost).toBe(multiplyToCurrency('0.50', '1.00', 'JPY'));
    expect(f).toMatchObject({ revenue: '2.00', cost: '1.00' }); // ¥0.5 cost rounds half-up to ¥1
    expect(computeQuoteProfit(toPanelLines(lines)).totalCost).toBe('0.50'); // the panel keeps half a yen
  });
});
