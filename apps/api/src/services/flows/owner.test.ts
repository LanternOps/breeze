import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));

vi.mock('../../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => selectMock() }) }) }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { resolveFlowOwnerForCaller } from './owner';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../partnerWideAccess';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '33333333-3333-4333-8333-333333333333';
const PARTNER = '22222222-2222-4222-8222-222222222222';

function orgAuth(): AuthContext {
  return {
    scope: 'organization', orgId: ORG_A, partnerId: PARTNER, accessibleOrgIds: [ORG_A],
    canAccessOrg: (id: string) => id === ORG_A, user: { id: 'u1' },
  } as unknown as AuthContext;
}

function partnerAuth(orgAccess: 'all' | 'selected'): AuthContext {
  return {
    scope: 'partner', orgId: null, partnerId: PARTNER, partnerOrgAccess: orgAccess,
    accessibleOrgIds: [ORG_A, ORG_B], canAccessOrg: (id: string) => id === ORG_A || id === ORG_B, user: { id: 'u2' },
  } as unknown as AuthContext;
}

describe('resolveFlowOwnerForCaller', () => {
  beforeEach(() => {
    selectMock.mockReset();
    selectMock.mockResolvedValue([{ partnerId: PARTNER }]);
  });

  it('org user naming another org is refused before any DB read', async () => {
    const r = await resolveFlowOwnerForCaller(orgAuth(), { orgId: ORG_B }, 'write');
    expect(r).toEqual({ error: expect.any(String) });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('org user asking for a partner-wide owner is refused before any DB read', async () => {
    const r = await resolveFlowOwnerForCaller(orgAuth(), { ownerScope: 'partner' }, 'read');
    expect(r).toEqual({ error: expect.any(String) });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('selected-access partner user: partner owner refused for write, allowed for read', async () => {
    const w = await resolveFlowOwnerForCaller(partnerAuth('selected'), { ownerScope: 'partner' }, 'write');
    expect(w).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    const r = await resolveFlowOwnerForCaller(partnerAuth('selected'), { ownerScope: 'partner' }, 'read');
    expect(r).toEqual({ owner: { orgId: null, partnerId: PARTNER } });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('full-access partner user may own a partner-wide flow', async () => {
    const r = await resolveFlowOwnerForCaller(partnerAuth('all'), { ownerScope: 'partner' }, 'write');
    expect(r).toEqual({ owner: { orgId: null, partnerId: PARTNER } });
  });

  it('org owner: partnerId comes from organizations, not from the token', async () => {
    selectMock.mockResolvedValue([{ partnerId: '44444444-4444-4444-8444-444444444444' }]);
    const r = await resolveFlowOwnerForCaller(orgAuth(), {}, 'write');
    expect(r).toEqual({ owner: { orgId: ORG_A, partnerId: '44444444-4444-4444-8444-444444444444' } });
  });

  it('partner user without orgId on an ambiguous multi-org token is asked for orgId', async () => {
    const r = await resolveFlowOwnerForCaller(partnerAuth('all'), {}, 'write');
    expect(r).toEqual({ error: expect.stringMatching(/orgId/) });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('partner user naming an accessible org gets that org as owner', async () => {
    const r = await resolveFlowOwnerForCaller(partnerAuth('selected'), { orgId: ORG_B }, 'write');
    expect(r).toEqual({ owner: { orgId: ORG_B, partnerId: PARTNER } });
  });

  it('orgId combined with ownerScope partner is refused', async () => {
    const r = await resolveFlowOwnerForCaller(partnerAuth('all'), { ownerScope: 'partner', orgId: ORG_A }, 'write');
    expect(r).toEqual({ error: expect.any(String) });
  });

  it('an org that no longer exists is refused', async () => {
    selectMock.mockResolvedValue([]);
    const r = await resolveFlowOwnerForCaller(orgAuth(), {}, 'read');
    expect(r).toEqual({ error: expect.any(String) });
  });
});
