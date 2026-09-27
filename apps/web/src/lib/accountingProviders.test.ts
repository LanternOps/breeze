import { describe, expect, it } from 'vitest';
import { accountingPath, ACCOUNTING_PROVIDER_NAMES, ACCOUNTING_PROVIDER_PRODUCT_NAMES, isAccountingProviderId } from './accountingProviders';

describe('accountingProviders', () => {
  it('builds provider-scoped API paths', () => {
    expect(accountingPath('quickbooks')).toBe('/accounting/quickbooks');
    expect(accountingPath('quickbooks', '/invoices/push-bulk')).toBe('/accounting/quickbooks/invoices/push-bulk');
    expect(accountingPath('xero', '/connect')).toBe('/accounting/xero/connect');
  });
  it('knows brand names and ids', () => {
    expect(ACCOUNTING_PROVIDER_NAMES.quickbooks).toBe('QuickBooks');
    expect(ACCOUNTING_PROVIDER_NAMES.xero).toBe('Xero');
    expect(isAccountingProviderId('xero')).toBe(true);
    expect(isAccountingProviderId('stripe')).toBe(false);
  });
  it('knows full product names, distinct from the brand name only for QuickBooks', () => {
    expect(ACCOUNTING_PROVIDER_PRODUCT_NAMES.quickbooks).toBe('QuickBooks Online');
    expect(ACCOUNTING_PROVIDER_PRODUCT_NAMES.xero).toBe('Xero');
  });
});
