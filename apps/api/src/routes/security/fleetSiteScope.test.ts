/**
 * The fleet posture routes hand the caller's site ceiling to the posture
 * service, so latest posture, score breakdown, dashboard, recommendations and
 * trends are computed over visible devices only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => {
  const chain = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const method of ['from', 'leftJoin', 'innerJoin', 'where', 'orderBy', 'groupBy', 'limit']) {
      b[method] = () => b;
    }
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve([]).then(resolve, reject);
    return b;
  };
  return {
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    db: { select: vi.fn(() => chain()) },
  };
});

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: {},
  queueCommand: vi.fn(async () => undefined),
}));

vi.mock('../../services/securityPosture', () => ({
  listLatestSecurityPosture: vi.fn(async () => []),
  getSecurityPostureTrend: vi.fn(async () => []),
  getLatestSecurityPostureForDevice: vi.fn(async () => null),
}));

const { getUserPermissionsMock } = vi.hoisted(() => ({
  getUserPermissionsMock: vi.fn(),
}));

vi.mock('../../services/permissions', async () => {
  const actual = await vi.importActual<any>('../../services/permissions');
  return { ...actual, getUserPermissions: getUserPermissionsMock };
});

vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return { ...actual, requireScope: vi.fn(() => async (_c: any, next: any) => next()) };
});

import { getSecurityPostureTrend, listLatestSecurityPosture } from '../../services/securityPosture';
import { complianceRoutes } from './compliance';
import { dashboardRoutes } from './dashboard';
import { postureRoutes } from './posture';
import { recommendationsRoutes } from './recommendations';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';

function buildApp(allowedSiteIds: string[] | undefined): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      canAccessOrg: (id: string) => id === ORG_ID,
      orgCondition: () => undefined,
      allowedSiteIds,
      canAccessSite: (siteId: string | null | undefined) =>
        allowedSiteIds === undefined || (!!siteId && allowedSiteIds.includes(siteId)),
    } as any);
    await next();
  });
  app.route('/security', dashboardRoutes);
  app.route('/security', postureRoutes);
  app.route('/security', complianceRoutes);
  app.route('/security', recommendationsRoutes);
  return app;
}

const ENDPOINTS = [
  '/security/dashboard',
  '/security/score-breakdown',
  '/security/posture',
  '/security/trends?period=7d',
  '/security/recommendations',
];

function postureReadSiteIds(): unknown[] {
  return [
    ...vi.mocked(listLatestSecurityPosture).mock.calls.map(([filter]) => (filter as { siteIds?: unknown }).siteIds),
    ...vi.mocked(getSecurityPostureTrend).mock.calls.map(([params]) => (params as { siteIds?: unknown }).siteIds),
  ];
}

describe('fleet posture routes — site ceiling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });
  });

  it.each(ENDPOINTS)('%s passes the selected sites to every posture read', async (path) => {
    const res = await buildApp([SITE_ID]).request(path);
    expect(res.status).toBe(200);
    const siteIds = postureReadSiteIds();
    expect(siteIds.length).toBeGreaterThan(0);
    for (const value of siteIds) expect(value).toEqual([SITE_ID]);
  });

  it.each(ENDPOINTS)('%s passes an empty allowlist through unchanged', async (path) => {
    const res = await buildApp([]).request(path);
    expect(res.status).toBe(200);
    const siteIds = postureReadSiteIds();
    expect(siteIds.length).toBeGreaterThan(0);
    for (const value of siteIds) expect(value).toEqual([]);
  });

  it.each(ENDPOINTS)('%s stays unrestricted without a site ceiling', async (path) => {
    const res = await buildApp(undefined).request(path);
    expect(res.status).toBe(200);
    for (const value of postureReadSiteIds()) expect(value).toBeUndefined();
  });
});
