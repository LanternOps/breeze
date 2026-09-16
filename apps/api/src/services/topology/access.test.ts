import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthContext } from '../../middleware/auth';
import type { UserPermissions } from '../permissions';
import {
  requireTopologySiteAccess,
  topologyPermissionPairs,
} from './access';

const ORG_A = '00000000-0000-4000-8000-000000000001';
const ORG_B = '00000000-0000-4000-8000-000000000002';
const SITE_A = '00000000-0000-4000-8000-000000000011';

const dbMocks = vi.hoisted(() => ({
  select: vi.fn(),
  limit: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { select: dbMocks.select },
}));

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: {
      id: '00000000-0000-4000-8000-000000000101',
      email: 'topology@example.com',
      name: 'Topology User',
      isPlatformAdmin: false,
    },
    token: null,
    partnerId: null,
    orgId: ORG_A,
    scope: 'organization',
    accessibleOrgIds: [ORG_A],
    orgCondition: vi.fn(),
    canAccessOrg: (orgId) => orgId === ORG_A,
    ...overrides,
  } as AuthContext;
}

function makePermissions(
  grants: Array<{ resource: string; action: string }>,
  overrides: Partial<UserPermissions> = {},
): UserPermissions {
  return {
    permissions: grants,
    partnerId: null,
    orgId: ORG_A,
    roleId: '00000000-0000-4000-8000-000000000201',
    scope: 'organization',
    ...overrides,
  };
}

const READ_GRANTS = [
  { resource: 'topology', action: 'read' },
  { resource: 'devices', action: 'read' },
];

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.limit.mockResolvedValue([{ id: SITE_A, orgId: ORG_A }]);
  dbMocks.select.mockReturnValue({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: dbMocks.limit })),
    })),
  });
});

describe('topologyPermissionPairs', () => {
  it.each([
    ['read', [['topology', 'read'], ['devices', 'read']]],
    ['write', [['topology', 'read'], ['devices', 'read'], ['topology', 'write']]],
    ['execute', [
      ['topology', 'read'],
      ['devices', 'read'],
      ['topology', 'execute'],
      ['devices', 'execute'],
    ]],
    ['configure', [
      ['topology', 'read'],
      ['devices', 'read'],
      ['topology', 'write'],
      ['devices', 'write'],
      ['devices', 'execute'],
    ]],
  ] as const)('defines the complete %s matrix', (capability, expected) => {
    expect(topologyPermissionPairs(capability)).toEqual(expected);
  });
});

describe('requireTopologySiteAccess', () => {
  it('returns the server-resolved site scope for an unrestricted valid caller', async () => {
    const auth = makeAuth({ allowedSiteIds: undefined });
    const permissions = makePermissions(READ_GRANTS, { allowedSiteIds: undefined });

    await expect(requireTopologySiteAccess(auth, permissions, SITE_A, 'read')).resolves.toEqual({
      auth,
      permissions,
      scope: { orgId: ORG_A, siteId: SITE_A },
    });
  });

  it('hides an unknown site', async () => {
    dbMocks.limit.mockResolvedValue([]);

    await expect(
      requireTopologySiteAccess(makeAuth(), makePermissions(READ_GRANTS), SITE_A, 'read'),
    ).rejects.toMatchObject({
      code: 'topology_site_not_found',
      status: 404,
      message: 'Topology site not found',
    });
  });

  it('hides a site outside the authenticated org ceiling', async () => {
    dbMocks.limit.mockResolvedValue([{ id: SITE_A, orgId: ORG_B }]);

    await expect(
      requireTopologySiteAccess(makeAuth(), makePermissions(READ_GRANTS), SITE_A, 'read'),
    ).rejects.toMatchObject({ code: 'topology_site_not_found', status: 404 });
  });

  it('hides a mixed auth/permission org scope even when auth alone allows it', async () => {
    dbMocks.limit.mockResolvedValue([{ id: SITE_A, orgId: ORG_B }]);
    const auth = makeAuth({ canAccessOrg: () => true });
    const permissions = makePermissions(READ_GRANTS, { orgId: ORG_A });

    await expect(
      requireTopologySiteAccess(auth, permissions, SITE_A, 'read'),
    ).rejects.toMatchObject({ code: 'topology_site_not_found', status: 404 });
  });

  it('preserves an empty auth site allowlist as deny-all', async () => {
    await expect(
      requireTopologySiteAccess(
        makeAuth({ allowedSiteIds: [] }),
        makePermissions(READ_GRANTS, { allowedSiteIds: undefined }),
        SITE_A,
        'read',
      ),
    ).rejects.toMatchObject({ code: 'topology_site_not_found', status: 404 });
  });

  it('preserves an empty permission site allowlist as deny-all', async () => {
    await expect(
      requireTopologySiteAccess(
        makeAuth({ allowedSiteIds: undefined }),
        makePermissions(READ_GRANTS, { allowedSiteIds: [] }),
        SITE_A,
        'read',
      ),
    ).rejects.toMatchObject({ code: 'topology_site_not_found', status: 404 });
  });

  it('intersects auth and permission site ceilings', async () => {
    const otherSite = '00000000-0000-4000-8000-000000000012';

    await expect(
      requireTopologySiteAccess(
        makeAuth({ allowedSiteIds: [SITE_A] }),
        makePermissions(READ_GRANTS, { allowedSiteIds: [otherSite] }),
        SITE_A,
        'read',
      ),
    ).rejects.toMatchObject({ code: 'topology_site_not_found', status: 404 });
  });

  it('returns 403 only after scope succeeds but an operation grant is missing', async () => {
    await expect(
      requireTopologySiteAccess(
        makeAuth(),
        makePermissions([{ resource: 'topology', action: 'read' }]),
        SITE_A,
        'read',
      ),
    ).rejects.toMatchObject({
      code: 'topology_permission_denied',
      status: 403,
      message: 'Topology permission denied',
    });
  });

  it('denies real M0 grants that omit topology:execute', async () => {
    const grants = [
      ...READ_GRANTS,
      { resource: 'topology', action: 'write' },
      { resource: 'devices', action: 'execute' },
    ];

    await expect(
      requireTopologySiteAccess(makeAuth(), makePermissions(grants), SITE_A, 'execute'),
    ).rejects.toMatchObject({ code: 'topology_permission_denied', status: 403 });
  });

  it('accepts the constructed execute matrix without treating it as an action authorization', async () => {
    const grants = topologyPermissionPairs('execute').map(([resource, action]) => ({ resource, action }));

    await expect(
      requireTopologySiteAccess(makeAuth(), makePermissions(grants), SITE_A, 'execute'),
    ).resolves.toMatchObject({ scope: { orgId: ORG_A, siteId: SITE_A } });
  });

  it('rejects a malformed site id without querying PostgreSQL', async () => {
    await expect(
      requireTopologySiteAccess(makeAuth(), makePermissions(READ_GRANTS), 'not-a-uuid', 'read'),
    ).rejects.toMatchObject({ code: 'topology_site_not_found', status: 404 });
    expect(dbMocks.select).not.toHaveBeenCalled();
  });
});
