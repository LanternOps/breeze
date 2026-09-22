import { describe, it, expect } from 'vitest';
import { BACKUP_PROVIDER_KEYS, getBackupProvider, isBackupProviderKey, listBackupProviders } from './registry';

describe('backup provider registry', () => {
  it('exposes exactly the shipped provider keys', () => {
    expect(BACKUP_PROVIDER_KEYS).toEqual(['cove']);
  });

  it('returns a fully-formed adapter for a known key', () => {
    const adapter = getBackupProvider('cove');
    expect(adapter.key).toBe('cove');
    expect(adapter.label).toBe('Cove Data Protection');
    expect(typeof adapter.testConnection).toBe('function');
    expect(typeof adapter.listCustomers).toBe('function');
    expect(typeof adapter.listDevices).toBe('function');
    // The schema must actually validate — a bare z.any() here would let a
    // malformed blob reach the vendor client.
    expect(adapter.credentialsSchema.safeParse({}).success).toBe(false);
  });

  it('throws, naming the known keys, for an unknown provider', () => {
    expect(() => getBackupProvider('veeam')).toThrow(/veeam/);
    expect(() => getBackupProvider('veeam')).toThrow(/cove/);
  });

  it('throws for a non-string-shaped key rather than returning undefined', () => {
    // A route reads `provider` off the row; a NULL or a stale value must fail
    // loudly in the sync worker, not produce `undefined.listDevices`.
    expect(() => getBackupProvider('')).toThrow();
    expect(() => getBackupProvider('__proto__')).toThrow();
  });

  it('isBackupProviderKey narrows without throwing', () => {
    expect(isBackupProviderKey('cove')).toBe(true);
    expect(isBackupProviderKey('veeam')).toBe(false);
    expect(isBackupProviderKey('__proto__')).toBe(false);
  });

  it('every registered adapter keys itself consistently', () => {
    for (const adapter of listBackupProviders()) {
      expect(BACKUP_PROVIDER_KEYS).toContain(adapter.key);
      expect(getBackupProvider(adapter.key)).toBe(adapter);
    }
  });
});
