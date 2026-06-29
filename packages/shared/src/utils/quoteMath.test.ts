import { describe, it, expect } from 'vitest';
import { computeQuoteTotals, computeLineTotal, toCents, fromCents, markupPct, priceFromMarkup, computeQuoteProfit, type QuoteLineForMath } from './quoteMath';

const line = (over: Partial<QuoteLineForMath>): QuoteLineForMath => ({
  quantity: '1', unitPrice: '0', taxable: false, recurrence: 'one_time', customerVisible: true, ...over,
});

describe('quoteMath (shared)', () => {
  it('buckets one-time vs monthly vs annual and taxes only taxable lines', () => {
    const r = computeQuoteTotals([
      line({ quantity: '2', unitPrice: '500', recurrence: 'one_time', taxable: true }),
      line({ quantity: '10', unitPrice: '22', recurrence: 'monthly', taxable: true }),
      line({ quantity: '1', unitPrice: '1200', recurrence: 'annual', taxable: false }),
    ], 0.1);
    expect(r.oneTimeTotal).toBe('1000.00');
    expect(r.monthlyRecurringTotal).toBe('220.00');
    expect(r.annualRecurringTotal).toBe('1200.00');
    expect(r.subtotal).toBe('2420.00');
    expect(r.taxTotal).toBe('122.00'); // (1000 + 220) * 0.1
    expect(r.total).toBe('2542.00');
  });

  it('dueOnAcceptanceTotal is the one-time subtotal + tax on one-time lines only', () => {
    const r = computeQuoteTotals([
      line({ quantity: '1', unitPrice: '500', recurrence: 'one_time', taxable: true }),
      line({ quantity: '1', unitPrice: '1000', recurrence: 'monthly', taxable: true }),
    ], 0.1);
    expect(r.taxTotal).toBe('150.00');             // whole-quote tax incl. monthly
    expect(r.dueOnAcceptanceTotal).toBe('550.00'); // one-time 500 + its 50 tax
    expect(r.dueOnAcceptanceTotal).not.toBe(r.total);
  });

  it('excludes non-customer-visible lines and treats null taxRate as zero', () => {
    expect(computeQuoteTotals([line({ unitPrice: '100', customerVisible: false })], 0).subtotal).toBe('0.00');
    const r = computeQuoteTotals([line({ unitPrice: '100', taxable: true })], null);
    expect(r.taxTotal).toBe('0.00');
    expect(r.total).toBe('100.00');
  });

  it('rounds at the cent boundary without rounding unitPrice first', () => {
    // 0.05 * 0.70 = 0.035 → 3.4999.. cents → floor(+0.5) = 3 → 0.03 (not 0.04).
    expect(computeLineTotal('0.05', '0.70')).toBe('0.03');
    expect(computeQuoteTotals([line({ quantity: '0.05', unitPrice: '0.70' })], null).subtotal).toBe('0.03');
    // sub-cent unit prices survive: 3 * 0.335 = 1.005 → round half-up → 1.01.
    expect(computeLineTotal('3', '0.335')).toBe('1.01');
  });

  it('cents helpers round-trip and treat blank as zero', () => {
    expect(toCents('12.34')).toBe(1234);
    expect(toCents('')).toBe(0);
    expect(toCents(null)).toBe(0);
    expect(fromCents(1234)).toBe('12.34');
  });

  it('markupPct: (price-cost)/cost, null when cost absent/zero', () => {
    expect(markupPct('130', '100')).toBeCloseTo(30);
    expect(markupPct('130', null)).toBeNull();
    expect(markupPct('130', '0')).toBeNull();
  });

  it('priceFromMarkup: cost*(1+m), cent-rounded', () => {
    expect(priceFromMarkup('100', 30)).toBe('130.00');
    expect(priceFromMarkup('9.99', 50)).toBe('14.99'); // 14.985 -> 14.99
  });

  it('computeQuoteProfit: net by cadence, excl tax, billed-only, flags missing cost', () => {
    const lineHelper = (o: Partial<QuoteLineForMath>) => ({
      quantity: '1', unitPrice: '0', taxable: false, customerVisible: true, recurrence: 'one_time' as const, ...o,
    });
    const r = computeQuoteProfit([
      lineHelper({ unitPrice: '130', unitCost: '100' }),                       // one-time net 30
      lineHelper({ unitPrice: '40', unitCost: '25', recurrence: 'monthly' }),  // monthly net 15
      lineHelper({ unitPrice: '50', unitCost: null }),                         // missing cost
      lineHelper({ unitPrice: '99', unitCost: '50', customerVisible: false }), // excluded (not billed)
    ]);
    expect(r.oneTimeNet).toBe('30.00');
    expect(r.monthlyRecurringNet).toBe('15.00');
    expect(r.totalCost).toBe('125.00');
    expect(r.linesMissingCost).toBe(1);
  });
});
