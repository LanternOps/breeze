import { describe, it, expect } from 'vitest';
import { computeLineTotal, computeInvoiceTotals, resolveEffectiveTaxRate, deriveInvoiceStatus } from './invoiceMath';

describe('computeLineTotal', () => {
  it('rounds half-up to cents', () => {
    expect(computeLineTotal('1.5', '150')).toBe('225.00');
    expect(computeLineTotal('3', '0.335')).toBe('1.01'); // 1.005 -> half-up 1.01
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
    expect(resolveEffectiveTaxRate({ taxExempt: true, orgRate: '0.1', partnerRate: '0.2' })).toBe('0.000');
  });
  it('org rate beats partner rate', () => {
    expect(resolveEffectiveTaxRate({ taxExempt: false, orgRate: '0.075', partnerRate: '0.2' })).toBe('0.075');
  });
  it('falls back to partner then zero', () => {
    expect(resolveEffectiveTaxRate({ taxExempt: false, orgRate: null, partnerRate: '0.2' })).toBe('0.200');
    expect(resolveEffectiveTaxRate({ taxExempt: false, orgRate: null, partnerRate: null })).toBe('0.000');
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
