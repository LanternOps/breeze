import { beforeEach, describe, expect, it, vi } from 'vitest';

const inserted: Array<Record<string, unknown>> = [];
vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        inserted.push(v);
        return { returning: vi.fn(async () => [{ id: 'inv-1' }]) };
      }),
    })),
  },
}));

import { recordInvocation, type NewInvocation } from './invocationLedgerWrite';

const base: NewInvocation = {
  orgId: 'org-1', surface: 'chat', fundingSource: 'platform', requestedModel: 'w10-test-m', servedModel: 'w10-test-m',
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, rateSnapshot: null, costCents: null, ledgerMode: 'authoritative',
};

beforeEach(() => { inserted.length = 0; });

describe('recordInvocation chargeback stamp (#7608)', () => {
  it('refuses an unstamped authoritative row', async () => {
    await expect(recordInvocation(base)).rejects.toThrow(/stampChargeback/);
    expect(inserted).toHaveLength(0);
  });
  it('writes every charge_* column from the stamp', async () => {
    await recordInvocation({ ...base, charge: { chargeable: true, billingProfileId: 'card-1', coverage: 'billable',
      basis: 'markup', currency: 'USD', amount: '5.000000' } });
    expect(inserted[0]).toMatchObject({ chargeable: true, chargeBillingProfileId: 'card-1', chargeCoverage: 'billable',
      chargeBasis: 'markup', chargeCurrency: 'USD', chargeAmount: '5.000000' });
  });
  it('a shadow row is never chargeable, whatever it carries', async () => {
    await recordInvocation({ ...base, ledgerMode: 'shadow', charge: { chargeable: true, billingProfileId: 'card-1',
      coverage: 'billable', basis: 'markup', currency: 'USD', amount: '1.000000' } });
    expect(inserted[0]).toMatchObject({ chargeable: false, chargeBillingProfileId: null, chargeCoverage: null,
      chargeBasis: null, chargeCurrency: null, chargeAmount: null });
  });
});
