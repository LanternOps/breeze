import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  context: null as null | { scope: string },
  executed: [] as unknown[],
}));
vi.mock('../../db', () => ({
  db: { execute: vi.fn(async (query: unknown) => { h.executed.push(query); return [{ acquired: true }]; }) },
  getCurrentDbAccessContext: () => h.context,
}));

import { lockPartnerRegistry, partnerRegistryLockKey } from './registryWriteLock';

describe('per-partner registry lock key', () => {
  it('keeps the W03 key text so a mixed-version deploy still serialises', () => {
    expect(partnerRegistryLockKey('p1')).toBe('ai_model_registry_reconcile:p1');
  });
});

describe('lockPartnerRegistry', () => {
  it('refuses outside a held system DB context', async () => {
    h.context = { scope: 'partner' };
    await expect(lockPartnerRegistry('p1')).rejects.toThrow(/system DB context/);
    h.context = null;
    await expect(lockPartnerRegistry('p1')).rejects.toThrow(/system DB context/);
    expect(h.executed).toHaveLength(0);
  });

  it('takes the blocking advisory lock in a system context', async () => {
    h.context = { scope: 'system' };
    await lockPartnerRegistry('p1');
    expect(h.executed).toHaveLength(1);
  });
});
