import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: {
    execute: vi.fn(async () => undefined),
  },
}));

vi.mock('../../db/schema', () => ({
  organizations: { id: 'organizations.id', partnerId: 'organizations.partner_id' },
  patchPolicies: { id: 'patch_policies.id', partnerId: 'patch_policies.partner_id' },
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { db } from '../../db';
import { PartnerWideWriteDeniedError } from '../../services/partnerWideAccess';
import { upsertPatchApproval } from './helpers';

const values = {
  partnerId: '11111111-1111-1111-1111-111111111111',
  patchId: '22222222-2222-4222-8222-222222222222',
  ringId: null,
  status: 'approved' as const,
};

function auth(scope: 'partner' | 'system', partnerOrgAccess: 'all' | 'selected' | 'none' | null) {
  return { scope, partnerOrgAccess } as any;
}

describe('upsertPatchApproval partner-wide authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['selected', 'none'] as const)('rejects partner org access %s before executing SQL', async (orgAccess) => {
    await expect(upsertPatchApproval(values, auth('partner', orgAccess)))
      .rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('allows full-partner authority', async () => {
    await upsertPatchApproval(values, auth('partner', 'all'));
    expect(db.execute).toHaveBeenCalledOnce();
  });

  it('allows system authority', async () => {
    await upsertPatchApproval(values, auth('system', null));
    expect(db.execute).toHaveBeenCalledOnce();
  });
});
