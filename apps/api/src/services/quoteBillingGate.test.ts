import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'leftJoin']) chain[m] = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows.value);
  return { db: chain };
});

import { assertQuoteBillingEnabled, assertQuoteBillingEnabledById } from './quoteBillingGate';
import { QuoteServiceError } from './quoteTypes';

describe('quoteBillingGate', () => {
  beforeEach(() => { rows.value = []; });

  it('billing off -> QuoteServiceError 404 BILLING_DISABLED', async () => {
    rows.value = [{ billingEnabled: false }];
    const err = await assertQuoteBillingEnabled('org1').catch((e) => e);
    expect(err).toBeInstanceOf(QuoteServiceError);
    expect(err).toMatchObject({ status: 404, code: 'BILLING_DISABLED', message: 'Not found' });
  });

  it('billing on -> passes', async () => {
    rows.value = [{ billingEnabled: true }];
    await expect(assertQuoteBillingEnabled('org1')).resolves.toBeUndefined();
  });

  it('by id: unknown quote passes through; known quote with billing off throws', async () => {
    rows.value = [];
    await expect(assertQuoteBillingEnabledById('q1')).resolves.toBeUndefined();
    // first read (quote org) returns the org, second (partner flag) returns off
    const limit = ((await import('../db')).db as unknown as { limit: ReturnType<typeof vi.fn> }).limit;
    limit.mockResolvedValueOnce([{ orgId: 'org1' }]).mockResolvedValueOnce([{ billingEnabled: false }]);
    await expect(assertQuoteBillingEnabledById('q1')).rejects.toMatchObject({ code: 'BILLING_DISABLED', status: 404 });
  });
});
