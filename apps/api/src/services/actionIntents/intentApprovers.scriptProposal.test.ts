import { describe, expect, it, vi, beforeEach } from 'vitest';

const resolveUsersWithPermissionForOrg = vi.fn();
vi.mock('../usersWithPermission', () => ({
  resolveUsersWithPermissionForOrg: (...a: unknown[]) => resolveUsersWithPermissionForOrg(...a),
}));
vi.mock('../../db', () => ({
  db: {}, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { resolveIntentApprovers } from './intentApprovers';
import { PERMISSIONS } from '../permissions';

const ORG = '11111111-1111-4111-8111-111111111111';
beforeEach(() => vi.clearAllMocks());

describe('resolveIntentApprovers (W03 alsoRequire)', () => {
  it('returns every approvals:decide holder when no extra permission is required', async () => {
    resolveUsersWithPermissionForOrg.mockResolvedValue(['u1', 'u2']);
    expect(await resolveIntentApprovers(ORG)).toEqual(['u1', 'u2']);
    expect(resolveUsersWithPermissionForOrg).toHaveBeenCalledTimes(1);
    expect(resolveUsersWithPermissionForOrg).toHaveBeenCalledWith(ORG, PERMISSIONS.APPROVALS_DECIDE);
  });

  it('intersects with the extra permission holders when one is required', async () => {
    resolveUsersWithPermissionForOrg
      .mockResolvedValueOnce(['u1', 'u2', 'u3'])
      .mockResolvedValueOnce(['u2', 'u9']);
    expect(await resolveIntentApprovers(ORG, { alsoRequire: PERMISSIONS.SCRIPTS_WRITE })).toEqual(['u2']);
    expect(resolveUsersWithPermissionForOrg).toHaveBeenNthCalledWith(2, ORG, PERMISSIONS.SCRIPTS_WRITE);
  });

  it('returns an empty list (never a widened one) when nobody holds both', async () => {
    resolveUsersWithPermissionForOrg.mockResolvedValueOnce(['u1']).mockResolvedValueOnce(['u9']);
    expect(await resolveIntentApprovers(ORG, { alsoRequire: PERMISSIONS.SCRIPTS_WRITE })).toEqual([]);
  });

  it('skips the second lookup when there are no deciders at all', async () => {
    resolveUsersWithPermissionForOrg.mockResolvedValueOnce([]);
    expect(await resolveIntentApprovers(ORG, { alsoRequire: PERMISSIONS.SCRIPTS_WRITE })).toEqual([]);
    expect(resolveUsersWithPermissionForOrg).toHaveBeenCalledTimes(1);
  });
});
