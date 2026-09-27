import { describe, expect, it } from 'vitest';
import {
  ACCOUNTING_PROVIDER_IDS,
  INVOICE_REMOTE_DELETED_ERROR,
  INVOICE_REMOTE_DELETED_MARKER_BY_PROVIDER,
  INVOICE_REMOTE_DELETED_MARKERS,
  invoiceRemoteDeletedMarker,
  isInvoiceRemoteDeletedMarker,
} from './types';

describe('invoice remote-deleted markers (Xero W01)', () => {
  it('the QuickBooks remote-deleted marker is byte-identical to what production rows hold', () => {
    expect(invoiceRemoteDeletedMarker('quickbooks')).toBe('Deleted in QuickBooks');
    expect(INVOICE_REMOTE_DELETED_MARKER_BY_PROVIDER.quickbooks).toBe('Deleted in QuickBooks');
    expect(INVOICE_REMOTE_DELETED_ERROR).toBe('Deleted in QuickBooks');
    expect(isInvoiceRemoteDeletedMarker('Deleted in QuickBooks')).toBe(true);
    expect(isInvoiceRemoteDeletedMarker('Deleted in Xero')).toBe(true);
    expect(isInvoiceRemoteDeletedMarker('Payment pull: Deleted in QuickBooks')).toBe(false);
    expect(isInvoiceRemoteDeletedMarker(null)).toBe(false);
    expect(isInvoiceRemoteDeletedMarker(undefined)).toBe(false);
  });

  it('the marker set is exactly one label per provider id', () => {
    expect([...INVOICE_REMOTE_DELETED_MARKERS]).toEqual(['Deleted in QuickBooks', 'Deleted in Xero']);
    expect(invoiceRemoteDeletedMarker('xero')).toBe('Deleted in Xero');
    expect(Object.keys(INVOICE_REMOTE_DELETED_MARKER_BY_PROVIDER).sort()).toEqual([...ACCOUNTING_PROVIDER_IDS].sort());
  });

  it.each([...ACCOUNTING_PROVIDER_IDS])(
    'the marker %s writes is recognised by every reader',
    (id) => {
      const marker = invoiceRemoteDeletedMarker(id);
      expect(isInvoiceRemoteDeletedMarker(marker)).toBe(true);
      expect(INVOICE_REMOTE_DELETED_MARKERS).toContain(marker);
    },
  );
});
