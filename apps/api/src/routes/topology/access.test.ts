import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import type { AuthContext } from '../../middleware/auth';
import type { UserPermissions } from '../../services/permissions';
import { createTopologyRoutes } from './index';
import { requireTopologySiteCapability } from './middleware';

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const SITE_ID = '00000000-0000-4000-8000-000000000011';

const routeMocks = vi.hoisted(() => ({
  auth: undefined as AuthContext | undefined,
  preloadedPermissions: undefined as UserPermissions | undefined,
  getUserPermissions: vi.fn(),
  select: vi.fn(),
  limit: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!c.req.header('authorization') || !routeMocks.auth) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    c.set('auth', routeMocks.auth);
    if (routeMocks.preloadedPermissions) {
      c.set('permissions', routeMocks.preloadedPermissions);
    }
    return next();
  }),
  siteAccessCheck: (allowedSiteIds?: string[]) => (siteId?: string | null) =>
    allowedSiteIds === undefined || (typeof siteId === 'string' && allowedSiteIds.includes(siteId)),
  // Route-construction middleware of the M3 arming routes mounted on the same hub.
  requireInteractiveSession: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
}));

vi.mock('../../services/permissions', async () => {
  const actual = await vi.importActual<typeof import('../../services/permissions')>(
    '../../services/permissions',
  );
  return { ...actual, getUserPermissions: routeMocks.getUserPermissions };
});

vi.mock('../../db', () => ({
  db: { select: routeMocks.select },
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
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    orgCondition: vi.fn(),
    canAccessOrg: (orgId) => orgId === ORG_ID,
    ...overrides,
  } as AuthContext;
}

function makePermissions(
  grants = [
    { resource: 'topology', action: 'read' },
    { resource: 'devices', action: 'read' },
  ],
  overrides: Partial<UserPermissions> = {},
): UserPermissions {
  return {
    permissions: grants,
    partnerId: null,
    orgId: ORG_ID,
    roleId: '00000000-0000-4000-8000-000000000201',
    scope: 'organization',
    ...overrides,
  };
}

function buildFixtureApp(capability: 'read' | 'write' | 'execute' | 'configure' = 'read'): Hono {
  const app = new Hono();
  const routes = createTopologyRoutes();
  routes.get(
    '/sites/:siteId/__access-fixture',
    requireTopologySiteCapability(capability),
    (c) => c.json({
      scope: c.get('topologyContext').scope,
      suppliedOrgId: c.req.query('orgId') ?? null,
    }),
  );
  app.route('/topology', routes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  routeMocks.auth = makeAuth();
  routeMocks.preloadedPermissions = undefined;
  routeMocks.getUserPermissions.mockResolvedValue(makePermissions());
  routeMocks.limit.mockResolvedValue([{ id: SITE_ID, orgId: ORG_ID }]);
  routeMocks.select.mockReturnValue({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: routeMocks.limit })),
    })),
  });
});

describe('topology route authorization composition', () => {
  it('requires authentication before a topology leaf runs', async () => {
    const response = await buildFixtureApp().request(
      `/topology/sites/${SITE_ID}/__access-fixture`,
    );

    expect(response.status).toBe(401);
    expect(routeMocks.getUserPermissions).not.toHaveBeenCalled();
  });

  it('returns a stable 403 when the authenticated caller has no role', async () => {
    routeMocks.getUserPermissions.mockResolvedValue(null);

    const response = await buildFixtureApp().request(
      `/topology/sites/${SITE_ID}/__access-fixture`,
      { headers: { Authorization: 'Bearer test' } },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Topology permission denied',
      code: 'topology_permission_denied',
    });
  });

  it('derives scope from the authorized site and ignores a supplied orgId', async () => {
    const suppliedOrgId = '00000000-0000-4000-8000-000000000099';

    const response = await buildFixtureApp().request(
      `/topology/sites/${SITE_ID}/__access-fixture?orgId=${suppliedOrgId}`,
      { headers: { Authorization: 'Bearer test' } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      scope: { orgId: ORG_ID, siteId: SITE_ID },
      suppliedOrgId,
    });
    expect(routeMocks.getUserPermissions).toHaveBeenCalledWith(
      routeMocks.auth!.user.id,
      { partnerId: undefined, orgId: ORG_ID, scope: 'organization' },
    );
  });

  it('reuses permissions already resolved by an upstream middleware', async () => {
    routeMocks.preloadedPermissions = makePermissions();

    const response = await buildFixtureApp().request(
      `/topology/sites/${SITE_ID}/__access-fixture`,
      { headers: { Authorization: 'Bearer test' } },
    );

    expect(response.status).toBe(200);
    expect(routeMocks.getUserPermissions).not.toHaveBeenCalled();
  });

  it('hides an allowed-org site forbidden by the permission site ceiling', async () => {
    routeMocks.getUserPermissions.mockResolvedValue(makePermissions(undefined, { allowedSiteIds: [] }));

    const response = await buildFixtureApp().request(
      `/topology/sites/${SITE_ID}/__access-fixture`,
      { headers: { Authorization: 'Bearer test' } },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Topology site not found',
      code: 'topology_site_not_found',
    });
  });

  it('returns 403 when scope is valid but capability permissions are incomplete', async () => {
    routeMocks.getUserPermissions.mockResolvedValue(makePermissions([
      { resource: 'topology', action: 'read' },
    ]));

    const response = await buildFixtureApp().request(
      `/topology/sites/${SITE_ID}/__access-fixture`,
      { headers: { Authorization: 'Bearer test' } },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Topology permission denied',
      code: 'topology_permission_denied',
    });
  });
});
