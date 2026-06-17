import { describe, it, expect } from 'vitest';
import { computeQuoteTotals, type QuoteLineForMath } from './quoteMath';
import { computeLineTotal } from './invoiceMath';

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

  it('rounds per-line cents identically to invoiceMath (no penny drift on 2dp inputs)', () => {
    // qty 0.05 * price 0.70 = 0.035 → round-half-up to 0.04? No: 0.05*0.70=0.035,
    // *100 = 3.4999... in float → floor(3.4999+0.5)=3 → 0.03. The old quoteMath
    // formula rounded unitPrice first and produced 0.04, diverging from invoices.
    const r = computeQuoteTotals(
      [line({ quantity: '0.05', unitPrice: '0.70', taxable: false, customerVisible: true, recurrence: 'one_time' })],
      null
    );
    expect(r.oneTimeTotal).toBe('0.03');
    expect(r.subtotal).toBe('0.03');
    // Cross-module consistency: quote subtotal equals the canonical line total.
    expect(r.subtotal).toBe(computeLineTotal('0.05', '0.70'));
  });
});
