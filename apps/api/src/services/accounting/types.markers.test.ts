import { describe, expect, it } from 'vitest';
import {
  INVOICE_REMOTE_DELETED_ERROR,
  INVOICE_REMOTE_DELETED_MARKERS,
  invoiceRemoteDeletedMarker,
  isInvoiceRemoteDeletedMarker,
} from './types';

describe('invoice remote-deleted markers (Xero W01)', () => {
  it('the QuickBooks remote-deleted marker is byte-identical to what production rows hold', () => {
    expect(invoiceRemoteDeletedMarker('QuickBooks')).toBe('Deleted in QuickBooks');
    expect(INVOICE_REMOTE_DELETED_ERROR).toBe('Deleted in QuickBooks');
    expect(isInvoiceRemoteDeletedMarker('Deleted in QuickBooks')).toBe(true);
    expect(isInvoiceRemoteDeletedMarker('Deleted in Xero')).toBe(true);
    expect(isInvoiceRemoteDeletedMarker('Payment pull: Deleted in QuickBooks')).toBe(false);
    expect(isInvoiceRemoteDeletedMarker(null)).toBe(false);
    expect(isInvoiceRemoteDeletedMarker(undefined)).toBe(false);
  });

  it('the closed marker set is exactly the two provider labels', () => {
    expect([...INVOICE_REMOTE_DELETED_MARKERS]).toEqual(['Deleted in QuickBooks', 'Deleted in Xero']);
    expect(invoiceRemoteDeletedMarker('Xero')).toBe('Deleted in Xero');
  });
});
