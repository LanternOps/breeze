import { describe, expect, it } from 'vitest';
import { PAYMENT_METHODS } from '@breeze/shared';
import { contracts } from './contracts';
import { invoices, paymentMethodEnum } from './invoices';
import { partners } from './orgs';
import { invoiceStripePayments, stripeConnectAccounts } from './stripePayments';

describe('autopay additions preserve historical defaults', () => {
  it('defaults every exclusion and rollout to false and every historical fee to zero', () => {
    expect(contracts.autopayExcluded.default).toBe(false);
    expect(invoices.autopayExcluded.default).toBe(false);
    expect(partners.autopayEnabled.default).toBe(false);
    expect(invoiceStripePayments.feeAmount.default).toBe('0');
    expect(invoiceStripePayments.source.default).toBe('checkout');
    expect(invoiceStripePayments.paymentMethodType.notNull).toBe(false);
    expect(stripeConnectAccounts.autopayMissingPermissions.notNull).toBe(true);
  });
  it('appends ACH without reordering historical enum values', () => {
    expect(PAYMENT_METHODS).toEqual(['cash','check','bank_transfer','card','other','ach_debit']);
    expect(paymentMethodEnum.enumValues).toEqual(PAYMENT_METHODS);
  });
});
