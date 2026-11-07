import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'leftJoin']) chain[m] = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows.value);
  return { db: chain };
});

import { assertContractBillingEnabled, assertContractBillingEnabledById } from './contractBillingGate';
import { ContractServiceError } from './contractTypes';

describe('contractBillingGate', () => {
  beforeEach(() => { rows.value = []; });

  it('billing off -> ContractServiceError 404 BILLING_DISABLED', async () => {
    rows.value = [{ billingEnabled: false }];
    const err = await assertContractBillingEnabled('org1').catch((e) => e);
    expect(err).toBeInstanceOf(ContractServiceError);
    expect(err).toMatchObject({ status: 404, code: 'BILLING_DISABLED', message: 'Not found' });
  });

  it('billing on -> passes', async () => {
    rows.value = [{ billingEnabled: true }];
    await expect(assertContractBillingEnabled('org1')).resolves.toBeUndefined();
  });

  it('by id: unknown contract passes through; known contract with billing off throws', async () => {
    rows.value = [];
    await expect(assertContractBillingEnabledById('c1')).resolves.toBeUndefined();
    // first read (contract org) returns the org, second (partner flag) returns off
    const limit = ((await import('../db')).db as unknown as { limit: ReturnType<typeof vi.fn> }).limit;
    limit.mockResolvedValueOnce([{ orgId: 'org1' }]).mockResolvedValueOnce([{ billingEnabled: false }]);
    await expect(assertContractBillingEnabledById('c1')).rejects.toMatchObject({ code: 'BILLING_DISABLED', status: 404 });
  });
});
