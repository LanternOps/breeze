import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  getUserPermissionsMock,
  getSecurityPostureTrendMock,
  listStatusRowsMock,
  buildBe9RecommendationsMock,
  getRecommendationStatusMapMock,
} = vi.hoisted(() => ({
  getUserPermissionsMock: vi.fn(),
  getSecurityPostureTrendMock: vi.fn(),
  listStatusRowsMock: vi.fn(),
  buildBe9RecommendationsMock: vi.fn(),
  getRecommendationStatusMapMock: vi.fn(),
}));

vi.mock('../../db', async () => {
  const actual = await vi.importActual<typeof import('../../db')>('../../db');
  return {
    ...actual,
    db: {
      select: vi.fn(),
      selectDistinct: vi.fn(),
    },
  };
});

vi.mock('../../services/permissions', async () => {
  const actual = await vi.importActual<typeof import('../../services/permissions')>('../../services/permissions');
  return { ...actual, getUserPermissions: getUserPermissionsMock };
});

vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../../middleware/auth')>('../../middleware/auth');
  return {
    ...actual,
    requireScope: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
  };
});

vi.mock('../../services/securityPosture', async () => {
  const actual = await vi.importActual<typeof import('../../services/securityPosture')>('../../services/securityPosture');
  return { ...actual, getSecurityPostureTrend: getSecurityPostureTrendMock };
});

vi.mock('./helpers', async () => {
  const actual = await vi.importActual<typeof import('./helpers')>('./helpers');
  return {
    ...actual,
    listStatusRows: listStatusRowsMock,
    buildBe9Recommendations: buildBe9RecommendationsMock,
    getRecommendationStatusMap: getRecommendationStatusMapMock,
  };
});

import { db } from '../../db';
import { complianceRoutes } from './compliance';
import { policiesRoutes } from './policies';
import { recommendationsRoutes } from './recommendations';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

const readRoutes = [
  { label: 'compliance trends', path: '/security/trends', invalidPath: '/security/trends?period=invalid' },
  { label: 'firewall compliance', path: '/security/firewall', invalidPath: '/security/firewall?orgId=invalid' },
  { label: 'encryption compliance', path: '/security/encryption', invalidPath: '/security/encryption?orgId=invalid' },
  { label: 'password-policy compliance', path: '/security/password-policy', invalidPath: '/security/password-policy?orgId=invalid' },
  { label: 'admin audit', path: '/security/admin-audit', invalidPath: '/security/admin-audit?orgId=invalid' },
  { label: 'security policies', path: '/security/policies', invalidPath: '/security/policies?scanSchedule=invalid' },
  { label: 'security recommendations', path: '/security/recommendations', invalidPath: '/security/recommendations?priority=invalid' },
] as const;

function mockPolicyRead(): void {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockResolvedValue([]),
      }),
    }),
  } as never);
}

function buildApp(scope: 'organization' | 'partner' | 'system' = 'organization', isPlatformAdmin = false): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope,
      orgId: scope === 'organization' ? ORG_ID : null,
      partnerId: scope === 'partner' ? '22222222-2222-4222-8222-222222222222' : null,
      accessibleOrgIds: scope === 'system' ? null : [ORG_ID],
      user: { id: 'user-1', email: 'billing@example.com', name: 'Billing User', isPlatformAdmin },
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
      orgCondition: () => undefined,
    } as never);
    await next();
  });
  app.route('/security', complianceRoutes);
  app.route('/security', policiesRoutes);
  app.route('/security', recommendationsRoutes);
  return app;
}

function expectNoReadSideEffects(): void {
  expect(db.select).not.toHaveBeenCalled();
  expect(db.selectDistinct).not.toHaveBeenCalled();
  expect(getSecurityPostureTrendMock).not.toHaveBeenCalled();
  expect(listStatusRowsMock).not.toHaveBeenCalled();
  expect(buildBe9RecommendationsMock).not.toHaveBeenCalled();
  expect(getRecommendationStatusMapMock).not.toHaveBeenCalled();
}

describe.each(readRoutes)('$label requires devices:read', ({ path, invalidPath }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSecurityPostureTrendMock.mockResolvedValue([]);
    listStatusRowsMock.mockResolvedValue([]);
    buildBe9RecommendationsMock.mockResolvedValue({ recommendations: [] });
    getRecommendationStatusMapMock.mockResolvedValue(new Map());
    mockPolicyRead();
  });

  it.each([
    ['no permissions row', null],
    ['billing-shaped permissions', { permissions: [{ resource: 'catalog', action: 'read' }], allowedSiteIds: undefined }],
    ['unrelated grant', { permissions: [{ resource: 'scripts', action: 'read' }], allowedSiteIds: undefined }],
  ])('denies %s before validation or read effects for org and partner scope', async (_label, permissions) => {
    getUserPermissionsMock.mockResolvedValue(permissions);

    for (const scope of ['organization', 'partner'] as const) {
      const response = await buildApp(scope).request(invalidPath);
      expect(response.status).toBe(403);
      expectNoReadSideEffects();
    }
  });

  it.each([
    ['the exact grant', { permissions: [{ resource: 'devices', action: 'read' }], allowedSiteIds: undefined }],
    ['a wildcard grant', { permissions: [{ resource: '*', action: '*' }], allowedSiteIds: undefined }],
  ])('allows %s to reach the handler for org and partner scope', async (_label, permissions) => {
    getUserPermissionsMock.mockResolvedValue(permissions);

    for (const scope of ['organization', 'partner'] as const) {
      const response = await buildApp(scope).request(path);
      expect(response.status).toBe(200);
    }
  });

  it('allows a live platform administrator in system scope without a membership lookup', async () => {
    const response = await buildApp('system', true).request(path);

    expect(response.status).toBe(200);
    expect(getUserPermissionsMock).not.toHaveBeenCalled();
  });

  it('does not allow a non-admin system-shaped context to bypass the gate', async () => {
    const response = await buildApp('system', false).request(invalidPath);

    expect(response.status).toBe(403);
    expect(getUserPermissionsMock).not.toHaveBeenCalled();
    expectNoReadSideEffects();
  });
});
