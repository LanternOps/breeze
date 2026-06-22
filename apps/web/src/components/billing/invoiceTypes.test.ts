import { describe, it, expect } from 'vitest';
import { INVOICE_STATUSES } from '@breeze/shared';
import { statusLabel, STATUS_LABELS, STATUS_COLORS } from './invoiceTypes';

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
