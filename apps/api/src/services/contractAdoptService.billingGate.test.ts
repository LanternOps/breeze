import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Partner billing master switch on adopt-draft (spec §7.1): the adopt deletes the
 * source draft, so with billing off it answers 404 BILLING_DISABLED and writes
 * nothing. The gate runs after the organization-access check, so a denied caller
 * never learns the flag. The gate itself is covered by contractBillingGate.test.ts.
 */
const mocks = vi.hoisted(() => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'update', 'set', 'delete', 'returning']) chain[m] = vi.fn(() => chain);
  chain.transaction = vi.fn(async (run: (tx: unknown) => unknown) => run(chain));
  return {
    chain,
    gate: vi.fn(),
    lockContractRow: vi.fn(),
    requireWholeContractSiteAccess: vi.fn(),
  };
});

vi.mock('../db', () => ({ db: mocks.chain }));
vi.mock('./contractBillingGate', () => ({ assertContractBillingEnabled: mocks.gate }));
vi.mock('./contractService', () => ({
  lockContractRow: mocks.lockContractRow,
  requireWholeContractSiteAccess: mocks.requireWholeContractSiteAccess,
}));
vi.mock('./serviceDeliverableService', () => ({
  DeliverableServiceError: class extends Error {},
  moveDeliverablesWithin: vi.fn(),
}));

import { adoptDraftContract } from './contractAdoptService';
import { ContractServiceError } from './contractTypes';

const TARGET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] } as never;
const row = (id: string, status: string, orgId = 'org1') => ({ id, orgId, name: id, status });

const writes = () => ['update', 'delete'].reduce(
  (n, m) => n + (mocks.chain[m] as { mock: { calls: unknown[] } }).mock.calls.length, 0);

describe('adoptDraftContract billing master switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lockContractRow.mockImplementation(async (_tx: unknown, id: string) =>
      id === TARGET ? row(TARGET, 'active') : row(SOURCE, 'draft'));
  });

  it('billing off answers 404 BILLING_DISABLED and deletes nothing', async () => {
    mocks.gate.mockRejectedValueOnce(new ContractServiceError('Not found', 404, 'BILLING_DISABLED'));
    await expect(adoptDraftContract(TARGET, { sourceContractId: SOURCE }, actor))
      .rejects.toMatchObject({ status: 404, code: 'BILLING_DISABLED' });
    expect(mocks.gate).toHaveBeenCalledWith('org1');
    expect(writes()).toBe(0);
  });

  it('an organization the caller cannot access is denied before the gate is consulted', async () => {
    await expect(adoptDraftContract(TARGET, { sourceContractId: SOURCE }, { ...actor as object, accessibleOrgIds: ['other'] } as never))
      .rejects.toMatchObject({ status: 403, code: 'ORG_DENIED' });
    expect(mocks.gate).not.toHaveBeenCalled();
  });

  it('a draft in another organization is a plain 404 before the gate is consulted', async () => {
    mocks.lockContractRow.mockImplementation(async (_tx: unknown, id: string) =>
      id === TARGET ? row(TARGET, 'active') : row(SOURCE, 'draft', 'org2'));
    await expect(adoptDraftContract(TARGET, { sourceContractId: SOURCE }, actor))
      .rejects.toMatchObject({ status: 404, code: 'CONTRACT_NOT_FOUND' });
    expect(mocks.gate).not.toHaveBeenCalled();
  });
});
