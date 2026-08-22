import { describe, it, expect } from 'vitest';
import { computeLineTotal, computeInvoiceTotals, resolveEffectiveTaxRate, deriveInvoiceStatus } from './invoiceMath';

describe('computeLineTotal', () => {
  it('rounds half-up to cents', () => {
    expect(computeLineTotal('1.5', '150')).toBe('225.00');
    expect(computeLineTotal('3', '0.335')).toBe('1.01'); // 1.005 -> half-up 1.01
  });
  it('rounds exact decimal ties half-up even when the double sits below the tie (review #2)', () => {
    // 1 minute at $7.25/h: 0.02 × 7.25 = 0.145 → 0.15; the double is 0.14499999999999999.
    expect(computeLineTotal('0.02', '7.25', 'USD')).toBe('0.15');
    expect(computeLineTotal('0.05', '0.70', 'USD')).toBe('0.04');
    // Zero-decimal half-unit boundary.
    expect(computeLineTotal('0.5', '5', 'JPY')).toBe('3.00');
  });
  it('handles zero', () => {
    expect(computeLineTotal('0', '99.99')).toBe('0.00');
  });
});

describe('computeInvoiceTotals', () => {
  it('sums customer-visible lines and applies tax to taxable visible lines', () => {
    const lines = [
      { lineTotal: '100.00', taxable: true, customerVisible: true },
      { lineTotal: '50.00', taxable: false, customerVisible: true },
      { lineTotal: '999.00', taxable: true, customerVisible: false } // hidden bundle child — excluded
    ];
    const t = computeInvoiceTotals(lines, '0.085'); // 8.5%
    expect(t.subtotal).toBe('150.00');
    expect(t.taxTotal).toBe('8.50');  // 100.00 * 0.085
    expect(t.total).toBe('158.50');
  });
  it('zero tax rate yields zero tax', () => {
    const t = computeInvoiceTotals([{ lineTotal: '100.00', taxable: true, customerVisible: true }], null);
    expect(t.taxTotal).toBe('0.00');
    expect(t.total).toBe('100.00');
  });
});

describe('resolveEffectiveTaxRate', () => {
  it('exempt overrides everything', () => {
    expect(resolveEffectiveTaxRate({ taxExempt: true, orgRate: '0.1', partnerRate: '0.2' })).toBe('0.00000');
  });
  it('org rate beats partner rate', () => {
    expect(resolveEffectiveTaxRate({ taxExempt: false, orgRate: '0.075', partnerRate: '0.2' })).toBe('0.07500');
  });
  it('falls back to partner then zero', () => {
    expect(resolveEffectiveTaxRate({ taxExempt: false, orgRate: null, partnerRate: '0.2' })).toBe('0.20000');
    expect(resolveEffectiveTaxRate({ taxExempt: false, orgRate: null, partnerRate: null })).toBe('0.00000');
  });
  it('preserves sub-percent precision (8.95%, 8.875%)', () => {
    expect(resolveEffectiveTaxRate({ taxExempt: false, orgRate: '0.0895', partnerRate: null })).toBe('0.08950');
    expect(resolveEffectiveTaxRate({ taxExempt: false, orgRate: '0.08875', partnerRate: null })).toBe('0.08875');
  });
});

describe('deriveInvoiceStatus', () => {
  const asOf = new Date('2026-06-14T00:00:00Z');
  it('void wins', () => {
    expect(deriveInvoiceStatus({ voided: true, issued: true, total: '100', amountPaid: '0', dueDate: null, asOf })).toBe('void');
  });
  it('not issued is draft', () => {
    expect(deriveInvoiceStatus({ voided: false, issued: false, total: '0', amountPaid: '0', dueDate: null, asOf })).toBe('draft');
  });
  it('balance<=0 is paid', () => {
    expect(deriveInvoiceStatus({ voided: false, issued: true, total: '100', amountPaid: '100', dueDate: '2026-01-01', asOf })).toBe('paid');
  });
  it('past due with balance is overdue (precedence over partial)', () => {
    expect(deriveInvoiceStatus({ voided: false, issued: true, total: '100', amountPaid: '40', dueDate: '2026-06-01', asOf })).toBe('overdue');
  });
  it('partial when paid>0 and not past due', () => {
    expect(deriveInvoiceStatus({ voided: false, issued: true, total: '100', amountPaid: '40', dueDate: '2026-12-01', asOf })).toBe('partially_paid');
  });
  it('sent when issued and nothing paid and not past due', () => {
    expect(deriveInvoiceStatus({ voided: false, issued: true, total: '100', amountPaid: '0', dueDate: '2026-12-01', asOf })).toBe('sent');
  });
});

describe('currency-aware rounding (multi-currency wave 1)', () => {
  it('computeLineTotal rounds to whole units for zero-decimal currencies', () => {
    // 3 × 333.5 = 1000.5 → JPY rounds half-up to 1001, stored fixed-2.
    expect(computeLineTotal('3', '333.50', 'JPY')).toBe('1001.00');
    // 2-decimal currencies keep the classic cent round (unchanged behavior).
    expect(computeLineTotal('3', '0.335', 'EUR')).toBe('1.01');
    // Back-compat: omitted currency === 2-decimal behavior.
    expect(computeLineTotal('3', '0.335')).toBe('1.01');
  });

  it('computeInvoiceTotals produces representable JPY tax/total', () => {
    const lines = [{ lineTotal: '1000.00', taxable: true, customerVisible: true }];
    const t = computeInvoiceTotals(lines, '0.10500', 'JPY'); // 10.5% of 1000 = 105 → integral anyway
    expect(t.taxTotal).toBe('105.00');
    const t2 = computeInvoiceTotals([{ lineTotal: '1001.00', taxable: true, customerVisible: true }], '0.10500', 'JPY');
    // 1001 * 0.105 = 105.105 → JPY tax must round to a whole unit, not 105.11
    expect(t2.taxTotal).toBe('105.00');
    expect(t2.total).toBe('1106.00');
  });

  it('keeps the historical cent-boundary tax round for 2-decimal currencies (FP regression)', () => {
    // $1.45 taxable at 10%: 145¢ × 0.10 lands at 14.5¢ (with upward FP noise) and
    // must round half-up to 15¢ exactly as the pre-currency code did. Rounding the
    // major-unit float (0.145 → 0.14499999999999998) instead would regress to 0.14.
    const t = computeInvoiceTotals([{ lineTotal: '1.45', taxable: true, customerVisible: true }], '0.10000');
    expect(t.taxTotal).toBe('0.15');
    expect(t.total).toBe('1.60');
  });

  it('JPY half-unit tax rounds up, not down through FP noise', () => {
    // ¥400 at 7.125% = 28.5 exactly → half-up to 29. Naive major-unit float math
    // yields 28.499999999999996 → 28; the cents-first path must land on 29.
    const t = computeInvoiceTotals([{ lineTotal: '400.00', taxable: true, customerVisible: true }], '0.07125', 'JPY');
    expect(t.taxTotal).toBe('29.00');
    expect(t.total).toBe('429.00');
  });
});
