import { describe, it, expect } from 'vitest';
import { formatInvoiceNumber } from './invoiceNumbers';

describe('formatInvoiceNumber', () => {
  it('zero-pads to 4 digits with prefix and year', () => {
    expect(formatInvoiceNumber('INV', 2026, 1)).toBe('INV-2026-0001');
    expect(formatInvoiceNumber('ACME', 2026, 1234)).toBe('ACME-2026-1234');
  });
  it('does not truncate counters beyond 4 digits', () => {
    expect(formatInvoiceNumber('INV', 2026, 12345)).toBe('INV-2026-12345');
  });
});
