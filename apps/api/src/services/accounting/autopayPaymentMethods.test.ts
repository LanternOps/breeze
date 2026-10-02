import { describe, expect, it } from 'vitest';
import { mapQboPaymentMethod } from './quickbooksProvider';
import { toChangeSetPaymentLine } from './xeroPayments';

describe('accounting ACH classification', () => {
  it('recognizes an explicit ACH debit name without inferring a rail from ambiguous names', () => {
    expect(mapQboPaymentMethod(' ACH DEBIT ')).toBe('ach_debit');
    expect(mapQboPaymentMethod('ACH')).toBe('other');
    expect(mapQboPaymentMethod('Wire')).toBe('other');
    expect(mapQboPaymentMethod(null)).toBe('other');
  });
  it('keeps Xero payments with no rail metadata unknown even when their reference says ACH', () => {
    const row = toChangeSetPaymentLine({ PaymentID:'payment-1', PaymentType:'ACCRECPAYMENT', Status:'AUTHORISED', Amount:10, Date:'2026-10-01', Reference:'ACH debit', Invoice:{ InvoiceID:'invoice-1', Type:'ACCREC', CurrencyCode:'USD' } }, {homeCurrency:'USD'});
    expect(row?.method).toBe('other');
    expect(row?.paymentMethodName).toBeNull();
  });
});
