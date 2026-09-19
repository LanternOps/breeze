import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * fix/pam-dedicated-permissions (§6E): resolveElevationApprovers no longer
 * hand-rolls the role/membership join itself — it delegates permission
 * resolution to `resolveUsersWithPermissionForOrg` (services/usersWithPermission.ts),
 * asking for PERMISSIONS.PAM_APPROVE instead of the old DEVICES_EXECUTE. That
 * function's own role/membership/wildcard/status='active' correctness is
 * covered exhaustively in usersWithPermission.test.ts; this file's job is
 * narrower: (a) resolveElevationApprovers asks for the RIGHT permission pair,
 * and (b) it still narrows the result to users with an active,
 * notifications-enabled mobile device — the one piece of logic that stays
 * local to the PAM mobile bridge.
 */
const { resolveUsersWithPermissionForOrgMock } = vi.hoisted(() => ({
  resolveUsersWithPermissionForOrgMock: vi.fn(),
}));

vi.mock('../db', () => ({
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  mobileDevices: { userId: 'user_id', status: 'status', notificationsEnabled: 'notifications_enabled' },
}));

vi.mock('./usersWithPermission', () => ({
  resolveUsersWithPermissionForOrg: resolveUsersWithPermissionForOrgMock,
}));

import { db } from '../db';
import { PERMISSIONS } from './permissions';
import { resolveElevationApprovers } from './pamApprovers';

function queueMobileSelect(rows: Array<{ userId: string }>) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as any);
}

describe('resolveElevationApprovers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks resolveUsersWithPermissionForOrg for pam:approve (NOT devices:execute)', async () => {
    resolveUsersWithPermissionForOrgMock.mockResolvedValue([]);

    await resolveElevationApprovers('org-1');

    expect(resolveUsersWithPermissionForOrgMock).toHaveBeenCalledWith('org-1', PERMISSIONS.PAM_APPROVE);
    expect(resolveUsersWithPermissionForOrgMock).not.toHaveBeenCalledWith('org-1', PERMISSIONS.DEVICES_EXECUTE);
  });

  it('returns [] without querying mobile devices when nobody holds pam:approve (e.g. an org of technicians only)', async () => {
    resolveUsersWithPermissionForOrgMock.mockResolvedValue([]);

    const result = await resolveElevationApprovers('org-1');

    expect(result).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('narrows pam:approve holders to those with an active, notifications-enabled mobile device', async () => {
    resolveUsersWithPermissionForOrgMock.mockResolvedValue(['u-admin', 'u-admin-no-phone']);
    queueMobileSelect([{ userId: 'u-admin' }]);

    const result = await resolveElevationApprovers('org-1');

    expect(result).toEqual(['u-admin']);
  });

  it('deduplicates the mobile-device result', async () => {
    resolveUsersWithPermissionForOrgMock.mockResolvedValue(['u-admin']);
    queueMobileSelect([{ userId: 'u-admin' }, { userId: 'u-admin' }]);

    const result = await resolveElevationApprovers('org-1');

    expect(result).toEqual(['u-admin']);
  });

  it('an Org Technician holding devices:execute but not pam:approve is never a candidate (enforced by resolveUsersWithPermissionForOrg, which this delegates to)', async () => {
    // Simulating what resolveUsersWithPermissionForOrg would actually return
    // for an org whose only role granting pam:approve is Org Admin: a
    // technician-only org yields an empty candidate set.
    resolveUsersWithPermissionForOrgMock.mockResolvedValue([]);

    const result = await resolveElevationApprovers('org-technicians-only');

    expect(result).toEqual([]);
  });
});
