import { describe, it, expect } from 'vitest';
import { computeQuoteTotals, type QuoteLineForMath } from './quoteMath';

const line = (over: Partial<QuoteLineForMath>): QuoteLineForMath => ({
  quantity: '1', unitPrice: '0', taxable: false, recurrence: 'one_time', customerVisible: true, ...over,
});

describe('computeQuoteTotals', () => {
  it('buckets one-time vs monthly vs annual', () => {
    const r = computeQuoteTotals([
      line({ quantity: '2', unitPrice: '500', recurrence: 'one_time', taxable: true }),   // 1000 one-time
      line({ quantity: '10', unitPrice: '22', recurrence: 'monthly', taxable: true }),      // 220/mo
      line({ quantity: '1', unitPrice: '1200', recurrence: 'annual', taxable: false }),     // 1200/yr
    ], 0.1);
    expect(r.oneTimeTotal).toBe('1000.00');
    expect(r.monthlyRecurringTotal).toBe('220.00');
    expect(r.annualRecurringTotal).toBe('1200.00');
    // subtotal = first invoice basis = one-time + first monthly + first annual period
    expect(r.subtotal).toBe('2420.00');
    // tax applies only to taxable lines (1000 + 220 = 1220) * 0.1 = 122.00
    expect(r.taxTotal).toBe('122.00');
    expect(r.total).toBe('2542.00');
  });

  it('excludes non-customer-visible lines from totals', () => {
    const r = computeQuoteTotals([
      line({ quantity: '1', unitPrice: '100', recurrence: 'one_time', customerVisible: false }),
    ], 0);
    expect(r.subtotal).toBe('0.00');
  });

  it('treats null taxRate as zero tax', () => {
    const r = computeQuoteTotals([line({ quantity: '1', unitPrice: '100', recurrence: 'one_time', taxable: true })], null);
    expect(r.taxTotal).toBe('0.00');
    expect(r.total).toBe('100.00');
  });
});
