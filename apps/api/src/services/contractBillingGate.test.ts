import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'leftJoin']) chain[m] = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows.value);
  // billingEnabled.ts reads the ambient DB context (org-scope partner-axis read).
  return { db: chain, getCurrentDbAccessContext: () => null };
});

import { assertContractBillingEnabled } from './contractBillingGate';
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
});
