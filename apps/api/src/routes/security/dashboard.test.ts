import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  securityStatus: {},
  securityThreats: {},
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: {},
  queueCommand: vi.fn(async () => undefined),
}));

vi.mock('../../services/securityPosture', () => ({
  listLatestSecurityPosture: vi.fn(async () => []),
  getSecurityPostureTrend: vi.fn(async () => []),
}));

const { getUserPermissionsMock } = vi.hoisted(() => ({
  getUserPermissionsMock: vi.fn(),
}));

vi.mock('../../services/permissions', async () => {
  const actual = await vi.importActual<any>('../../services/permissions');
  return {
    ...actual,
    getUserPermissions: getUserPermissionsMock,
  };
});

// Keep requireScope as a passthrough; use real requirePermission so RBAC
// is actually enforced in tests.
vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return {
    ...actual,
    requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  };
});

import { dashboardRoutes } from './dashboard';

const ORG_ID = '11111111-1111-1111-1111-111111111111';

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      canAccessOrg: () => true,
      orgCondition: () => undefined,
    } as any);
    await next();
  });
  app.route('/security', dashboardRoutes);
  return app;
}

describe('GET /dashboard — requirePermission(devices, read)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 403 when the caller has no permissions', async () => {
    getUserPermissionsMock.mockResolvedValue(null);
    const app = buildApp();

    const res = await app.request('/security/dashboard', { method: 'GET' });

    expect(res.status).toBe(403);
  });

  it('returns 403 when the caller lacks devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'scripts', action: 'read' }],
      allowedSiteIds: undefined,
    });
    const app = buildApp();

    const res = await app.request('/security/dashboard', { method: 'GET' });

    expect(res.status).toBe(403);
  });

  it('returns non-403 when the caller has devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });
    const app = buildApp();

    const res = await app.request('/security/dashboard', { method: 'GET' });

    expect(res.status).not.toBe(403);
  });
});

describe('GET /score-breakdown — requirePermission(devices, read)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 403 when the caller has no permissions', async () => {
    getUserPermissionsMock.mockResolvedValue(null);
    const app = buildApp();

    const res = await app.request('/security/score-breakdown', { method: 'GET' });

    expect(res.status).toBe(403);
  });

  it('returns 403 when the caller lacks devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'scripts', action: 'read' }],
      allowedSiteIds: undefined,
    });
    const app = buildApp();

    const res = await app.request('/security/score-breakdown', { method: 'GET' });

    expect(res.status).toBe(403);
  });

  it('returns non-403 when the caller has devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });
    const app = buildApp();

    const res = await app.request('/security/score-breakdown', { method: 'GET' });

    expect(res.status).not.toBe(403);
  });
});
