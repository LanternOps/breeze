/**
 * #11702 — the baseline gate's devices:write check reads the role's runtime
 * grants INCLUDING inherited ones (services/roleInheritance.ts). The match
 * stays EXACT (no `*` wildcard), exactly as it was against role_permissions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({ rows: [] as unknown[][] }));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      const result: any = Promise.resolve(dbState.rows.shift() ?? []);
      for (const m of ['from', 'where', 'limit', 'innerJoin', 'for']) result[m] = vi.fn(() => result);
      return result;
    }),
  },
}));

vi.mock('./roleInheritance', () => ({
  getRolePermissionGrants: vi.fn(async () => []),
}));

import { loadBaselineAuthoritySubject } from './networkBaselineAuthority';
import { getRolePermissionGrants } from './roleInheritance';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const ROLE_ID = '77777777-7777-4777-8777-777777777777';

function queueOrgMember() {
  dbState.rows.push(
    [{ id: USER_ID, status: 'active', permissionsEpoch: 1, mfaEpoch: 1 }],
    [{ roleId: ROLE_ID, siteIds: null }],
  );
}

describe('loadBaselineAuthoritySubject role grants (#11702)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.rows.length = 0;
  });

  it('honours devices:write held only through inheritance', async () => {
    queueOrgMember();
    vi.mocked(getRolePermissionGrants).mockResolvedValueOnce([{ resource: 'devices', action: 'write' }]);

    const subject = await loadBaselineAuthoritySubject(USER_ID, ORG_ID);

    expect(subject?.membership?.hasRequiredPermission).toBe(true);
    expect(getRolePermissionGrants).toHaveBeenCalledWith(ROLE_ID);
  });

  it('refuses when the resolved grants lack devices:write', async () => {
    queueOrgMember();
    vi.mocked(getRolePermissionGrants).mockResolvedValueOnce([{ resource: 'devices', action: 'read' }]);

    const subject = await loadBaselineAuthoritySubject(USER_ID, ORG_ID);
    expect(subject?.membership?.hasRequiredPermission).toBe(false);
  });

  it('keeps the match exact: a *:* wildcard grant does not satisfy devices:write', async () => {
    queueOrgMember();
    vi.mocked(getRolePermissionGrants).mockResolvedValueOnce([{ resource: '*', action: '*' }]);

    const subject = await loadBaselineAuthoritySubject(USER_ID, ORG_ID);
    expect(subject?.membership?.hasRequiredPermission).toBe(false);
  });
});
