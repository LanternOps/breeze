import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./permissions')>()),
  getUserPermissions: vi.fn(),
}));

import { getUserPermissions } from './permissions';
import { resolveContractActorFromAuth } from './contractActor';
import type { AuthContext } from '../middleware/auth';

const auth = {
  user: { id: 'u-1' },
  scope: 'partner',
  partnerId: 'p-1',
  orgId: null,
  accessibleOrgIds: ['org-1'],
} as unknown as AuthContext;

describe('resolveContractActorFromAuth', () => {
  beforeEach(() => {
    vi.mocked(getUserPermissions).mockReset();
    vi.mocked(getUserPermissions).mockResolvedValue({
      permissions: [{ resource: 'contracts', action: 'read' }],
      partnerId: 'p-1', orgId: null, roleId: 'r-1', scope: 'partner',
    } as never);
  });

  it('carries the caller site ceiling, matching the HTTP contractActorFrom()', async () => {
    const actor = await resolveContractActorFromAuth({ ...auth, allowedSiteIds: ['site-1'] } as AuthContext);
    expect(actor.allowedSiteIds).toEqual(['site-1']);
  });

  it('resolves permissions under the caller scope so the system-scope branch is reachable', async () => {
    await resolveContractActorFromAuth({ ...auth, scope: 'system', partnerId: null } as AuthContext);
    expect(getUserPermissions).toHaveBeenCalledWith('u-1', expect.objectContaining({ scope: 'system' }));
  });

  it('projects only the REAL resolved grants as evidence', async () => {
    const actor = await resolveContractActorFromAuth(auth);
    expect([...(actor.permissions ?? [])]).toEqual(['contracts:read']);
  });
});
