import { describe, expect, it } from 'vitest';
import { priceFromCostMarkup, computeMarginBreakdown, formatMarginSummary } from './marginMath';

describe('priceFromCostMarkup', () => {
  it('applies markup over cost, rounded to cents', () => {
    expect(priceFromCostMarkup(100, 25)).toBe(125);
    expect(priceFromCostMarkup(100, 0)).toBe(100);
    expect(priceFromCostMarkup(33.33, 30)).toBe(43.33); // 43.329 -> 43.33
  });
});

describe('computeMarginBreakdown', () => {
  it('returns null when cost or price is missing', () => {
    expect(computeMarginBreakdown(null, 100)).toBeNull();
    expect(computeMarginBreakdown(100, null)).toBeNull();
  });

  it('computes markup, margin, and profit', () => {
    const b = computeMarginBreakdown(100, 125)!;
    expect(b.profit).toBe(25);
    expect(b.markupPct).toBeCloseTo(25, 5); // 25/100
    expect(b.marginPct).toBeCloseTo(20, 5); // 25/125
  });

  it('reports negative profit when selling below cost', () => {
    const b = computeMarginBreakdown(100, 80)!;
    expect(b.profit).toBe(-20);
    expect(b.markupPct).toBeCloseTo(-20, 5);
  });

  it('avoids divide-by-zero on a zero cost', () => {
    const b = computeMarginBreakdown(0, 50)!;
    expect(b.markupPct).toBe(0);
    expect(b.marginPct).toBeCloseTo(100, 5);
  });
});

describe('formatMarginSummary', () => {
  it('renders a one-line summary with currency', () => {
    const b = computeMarginBreakdown(100, 125)!;
    expect(formatMarginSummary(b, 'USD')).toBe('Margin 20.0% · Markup 25.0% · Profit USD 25.00');
  });
});
