import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  runOutsideDbContext: <T>(fn: () => T) => fn(),
}));

describe('providerRegistry', () => {
  it('returns the QuickBooks provider', async () => {
    const { getAccountingProvider } = await import('./providerRegistry');
    expect(getAccountingProvider('quickbooks').provider).toBe('quickbooks');
  });

  it('throws for unknown providers', async () => {
    const { getAccountingProvider } = await import('./providerRegistry');
    expect(() => getAccountingProvider('bogus' as any)).toThrow(/Unknown accounting provider/);
  });

  it('QuickBooks declares every capability (Xero W01)', async () => {
    const { getAccountingProvider } = await import('./providerRegistry');
    expect(getAccountingProvider('quickbooks').capabilities).toEqual({
      connect: true, mapping: true, customerImport: true, invoicePush: true, paymentPull: true, paymentPush: true,
    });
    expect(getAccountingProvider('quickbooks').displayName).toBe('QuickBooks');
  });

  it('registers Xero with only the connect capability (W02)', async () => {
    const {
      findAccountingProvider, getAccountingProvider, providerSupports, accountingProviderDisplayName, listRegisteredAccountingProviders,
    } = await import('./providerRegistry');
    expect(findAccountingProvider('xero')?.displayName).toBe('Xero');
    expect(getAccountingProvider('xero').capabilities).toEqual({
      connect: true, mapping: false, customerImport: false, invoicePush: false, paymentPull: false, paymentPush: false,
    });
    expect(providerSupports('xero', 'connect')).toBe(true);
    for (const cap of ['mapping', 'customerImport', 'invoicePush', 'paymentPull', 'paymentPush'] as const) {
      expect(providerSupports('xero', cap)).toBe(false);
    }
    expect(providerSupports('quickbooks', 'invoicePush')).toBe(true);
    expect(accountingProviderDisplayName('xero')).toBe('Xero');
    expect(accountingProviderDisplayName('quickbooks')).toBe('QuickBooks');
    expect(listRegisteredAccountingProviders().map((p) => p.provider).sort()).toEqual(['quickbooks', 'xero']);
  });

  it('an id with no registered implementation supports nothing, is not found, and keeps its brand name via the fallback table (review R)', async () => {
    // Every current id is registered, so unregister Xero for this module instance only.
    vi.resetModules();
    vi.doMock('./xeroProvider', () => ({ xeroProvider: undefined }));
    try {
      const {
        findAccountingProvider, getAccountingProvider, providerSupports, accountingProviderDisplayName, listRegisteredAccountingProviders,
      } = await import('./providerRegistry');
      expect(findAccountingProvider('xero')).toBeNull();
      expect(() => getAccountingProvider('xero')).toThrow(/Unknown accounting provider: xero/);
      for (const cap of ['connect', 'mapping', 'customerImport', 'invoicePush', 'paymentPull', 'paymentPush'] as const) {
        expect(providerSupports('xero', cap)).toBe(false);
      }
      expect(accountingProviderDisplayName('xero')).toBe('Xero'); // FALLBACK_DISPLAY_NAMES
      expect(accountingProviderDisplayName('bogus' as never)).toBe('bogus'); // neither registered nor in the table
      expect(listRegisteredAccountingProviders().map((p) => p.provider)).toEqual(['quickbooks']);
    } finally {
      vi.doUnmock('./xeroProvider');
      vi.resetModules();
    }
  });

  it('legacy untargeted jobs belong to QuickBooks (spec: a job destination is never reinterpreted)', async () => {
    const { LEGACY_UNTARGETED_JOB_PROVIDER } = await import('./providerRegistry');
    expect(LEGACY_UNTARGETED_JOB_PROVIDER).toBe('quickbooks');
  });
});
