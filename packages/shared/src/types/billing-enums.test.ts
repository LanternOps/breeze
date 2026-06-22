import { describe, it, expect } from 'vitest';
import {
  INVOICE_STATUSES,
  PAYMENT_METHODS,
  INVOICE_LINE_SOURCE_TYPES,
} from './billing-enums';

describe('billing enum tuples (canonical source)', () => {
  it('invoice statuses match the shipped pgEnum values and order', () => {
    expect([...INVOICE_STATUSES]).toEqual([
      'draft', 'sent', 'partially_paid', 'overdue', 'paid', 'void',
    ]);
  });
  it('payment methods match the shipped pgEnum values and order', () => {
    expect([...PAYMENT_METHODS]).toEqual([
      'cash', 'check', 'bank_transfer', 'card', 'other',
    ]);
  });
  it('invoice line source types match the shipped pgEnum values and order', () => {
    expect([...INVOICE_LINE_SOURCE_TYPES]).toEqual([
      'time_entry', 'part', 'catalog', 'bundle', 'manual', 'contract',
    ]);
  });
});
