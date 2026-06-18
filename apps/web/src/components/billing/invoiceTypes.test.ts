import { describe, it, expect } from 'vitest';
import { statusLabel } from './invoiceTypes';

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
