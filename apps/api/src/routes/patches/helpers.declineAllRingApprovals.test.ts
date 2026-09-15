import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    execute: vi.fn(async () => undefined),
  },
}));

vi.mock('../../db/schema', () => ({
  organizations: { id: 'organizations.id', partnerId: 'organizations.partner_id' },
  patchPolicies: { id: 'patch_policies.id', partnerId: 'patch_policies.partner_id' },
  patchApprovals: {
    partnerId: 'patch_approvals.partner_id',
    patchId: 'patch_approvals.patch_id',
    ringId: 'patch_approvals.ring_id',
  },
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { db } from '../../db';
import { declineAllRingApprovals } from './helpers';

const PARTNER_ID = '11111111-1111-1111-1111-111111111111';
const PATCH_ID = '22222222-2222-4222-8222-222222222222';
const AUTH = { scope: 'partner' as const, partnerOrgAccess: 'all' as const };

function mockExistingRows(rows: Array<{ ringId: string | null }>) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as never);
}

describe('declineAllRingApprovals (#5585)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('declines every distinct ring row for the patch, plus the blanket row', async () => {
    mockExistingRows([{ ringId: 'ring-a' }, { ringId: 'ring-b' }, { ringId: null }]);

    const result = await declineAllRingApprovals(PARTNER_ID, PATCH_ID, 'nasty bug', AUTH);

    // 3 upserts: ring-a, ring-b, and the blanket (deduped — null was already present).
    expect(db.execute).toHaveBeenCalledTimes(3);
    expect(result.ringIds.sort()).toEqual([null, 'ring-a', 'ring-b'].sort());
  });

  it('still declines the blanket row when no ring approval exists yet', async () => {
    mockExistingRows([]);

    const result = await declineAllRingApprovals(PARTNER_ID, PATCH_ID, null, AUTH);

    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(result.ringIds).toEqual([null]);
  });

  it('does not duplicate a ring already present in existing rows', async () => {
    mockExistingRows([{ ringId: 'ring-a' }, { ringId: 'ring-a' }]);

    const result = await declineAllRingApprovals(PARTNER_ID, PATCH_ID, null, AUTH);

    // ring-a deduped to one write + the blanket = 2 total.
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(result.ringIds.sort()).toEqual([null, 'ring-a'].sort());
  });
});
