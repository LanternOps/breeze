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
});
