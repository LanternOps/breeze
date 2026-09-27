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

  it('an unregistered provider supports nothing but still has a display name', async () => {
    const { providerSupports, findAccountingProvider, accountingProviderDisplayName } = await import('./providerRegistry');
    expect(findAccountingProvider('xero')).toBeNull();
    expect(providerSupports('xero', 'connect')).toBe(false);
    expect(providerSupports('quickbooks', 'invoicePush')).toBe(true);
    expect(accountingProviderDisplayName('xero')).toBe('Xero');
    expect(accountingProviderDisplayName('quickbooks')).toBe('QuickBooks');
  });

  it('legacy untargeted jobs belong to QuickBooks (spec: a job destination is never reinterpreted)', async () => {
    const { LEGACY_UNTARGETED_JOB_PROVIDER } = await import('./providerRegistry');
    expect(LEGACY_UNTARGETED_JOB_PROVIDER).toBe('quickbooks');
  });
});
