import { describe, expect, it } from 'vitest';
import { accountingPath, ACCOUNTING_PROVIDER_NAMES, isAccountingProviderId } from './accountingProviders';

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
});
