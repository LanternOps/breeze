import { describe, it, expect } from 'vitest';
import { INVOICE_STATUSES } from '@breeze/shared';
import { computeInvoiceProfit, statusLabel, STATUS_LABELS, STATUS_COLORS, type InvoiceLine } from './invoiceTypes';

describe('billing UI enum maps track the shared SSOT', () => {
  it('STATUS_LABELS and STATUS_COLORS cover exactly the canonical statuses', () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...INVOICE_STATUSES].sort());
    expect(Object.keys(STATUS_COLORS).sort()).toEqual([...INVOICE_STATUSES].sort());
  });
});

describe('statusLabel', () => {
  it('labels an issued-but-not-emailed invoice "Issued", not "Sent"', () => {
    expect(statusLabel({ status: 'sent', sentAt: null })).toBe('Issued');
  });

  it('labels "Sent" only once an email actually went out', () => {
    expect(statusLabel({ status: 'sent', sentAt: '2026-06-16T00:00:00Z' })).toBe('Sent');
  });

  it('passes other statuses through unchanged', () => {
    expect(statusLabel({ status: 'draft', sentAt: null })).toBe('Draft');
    expect(statusLabel({ status: 'overdue', sentAt: null })).toBe('Overdue');
    expect(statusLabel({ status: 'paid', sentAt: '2026-06-16' })).toBe('Paid');
  });
});

// #3205 W04 decision 8: the overage is a TOP-LEVEL sibling, so its revenue is
// counted. If it were a bundle child, computeInvoiceProfit's
// `parentLineId === null` filter would drop it and margin would be understated.
describe('computeInvoiceProfit counts a contract overage sibling (#3205 W04)', () => {
  const il = (p: Partial<InvoiceLine>): InvoiceLine => ({
    id: 'x', invoiceId: 'inv', sourceType: 'contract', parentLineId: null, catalogItemId: null,
    name: null, description: 'x', quantity: '1.00', unitPrice: '0.00', costBasis: null,
    revenueAllocation: null, taxable: true, customerVisible: true, lineTotal: '0.00',
    isUnapprovedTime: false, sortOrder: 0, deviceCount: 0, ...p,
  });

  it('characterizes top-level sibling revenue accounting for a contract overage', () => {
    const withOverage = computeInvoiceProfit([
      il({ id: 'base', quantity: '25.00', unitPrice: '10.00', costBasis: '4.00', lineTotal: '250.00', sortOrder: 1 }),
      il({ id: 'over', quantity: '1.00', unitPrice: '12.00', costBasis: '4.00', lineTotal: '12.00', sortOrder: 2 }),
    ]);
    const baseOnly = computeInvoiceProfit([
      il({ id: 'base', quantity: '25.00', unitPrice: '10.00', costBasis: '4.00', lineTotal: '250.00', sortOrder: 1 }),
    ]);
    expect(Number(withOverage.oneTimeRevenue)).toBeGreaterThan(Number(baseOnly.oneTimeRevenue));
    expect(withOverage.linesMissingCost).toBe(0);
  });
});
