import { describe, it, expect, vi, beforeEach } from 'vitest';

const orgRows = vi.hoisted(() => ({ value: [] as Array<{ partnerId: string | null }> }));

vi.mock('../../db', () => ({
  db: { select: vi.fn(() => ({ from: () => ({ where: async () => orgRows.value }) })) },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../../db/schema/orgs', () => ({ organizations: { id: 'id', partnerId: 'partner_id' } }));
vi.mock('../permissions', () => ({ getUserPermissions: vi.fn(async () => ({ scope: 'partner', permissions: [] })) }));

import { getUserPermissions } from '../permissions';
import { getDeciderPermissionsForOrg } from './deciderPermissions';

const USER = '22222222-2222-4222-8222-222222222222';
const ORG = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  orgRows.value = [];
});

describe('getDeciderPermissionsForOrg', () => {
  it("resolves the user in the org and in the partner that owns it", async () => {
    orgRows.value = [{ partnerId: 'owner-partner' }];

    expect(await getDeciderPermissionsForOrg(USER, ORG)).toEqual({ scope: 'partner', permissions: [] });
    expect(getUserPermissions).toHaveBeenCalledWith(USER, { orgId: ORG, partnerId: 'owner-partner' });
  });

  it('is null for an org that no longer resolves, without resolving any permissions', async () => {
    expect(await getDeciderPermissionsForOrg(USER, ORG)).toBeNull();
    expect(getUserPermissions).not.toHaveBeenCalled();
  });

  it('an org with no owning partner resolves the org axis only', async () => {
    orgRows.value = [{ partnerId: null }];

    await getDeciderPermissionsForOrg(USER, ORG);
    expect(getUserPermissions).toHaveBeenCalledWith(USER, { orgId: ORG });
  });

  it('propagates a read failure', async () => {
    orgRows.value = [{ partnerId: 'owner-partner' }];
    vi.mocked(getUserPermissions).mockRejectedValueOnce(new Error('pool exhausted'));

    await expect(getDeciderPermissionsForOrg(USER, ORG)).rejects.toThrow('pool exhausted');
  });
});
