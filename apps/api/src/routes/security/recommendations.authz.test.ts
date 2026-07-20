import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { getUserPermissionsMock } = vi.hoisted(() => ({
  getUserPermissionsMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { insert: vi.fn() },
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({ auditLogs: {} }));

vi.mock('../../services/permissions', async () => {
  const actual = await vi.importActual<any>('../../services/permissions');
  return { ...actual, getUserPermissions: getUserPermissionsMock };
});

vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return {
    ...actual,
    requireScope: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
  };
});

vi.mock('./helpers', () => ({
  getPagination: vi.fn(),
  paginate: vi.fn(),
  getPolicyOrgId: vi.fn(() => '11111111-1111-4111-8111-111111111111'),
  getRecommendationStatusMap: vi.fn(),
  buildBe9Recommendations: vi.fn(async () => ({
    recommendations: [{ id: 'rec-1', priority: 'high', category: 'security' }],
  })),
}));

import { db } from '../../db';
import { recommendationsRoutes } from './recommendations';

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: '11111111-1111-4111-8111-111111111111',
      partnerId: null,
      user: { id: 'user-1', email: 'viewer@example.com', name: 'Viewer' },
    } as never);
    await next();
  });
  app.route('/security', recommendationsRoutes);
  return app;
}

describe.each(['complete', 'dismiss'] as const)('POST /recommendations/:id/%s authorization', (action) => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('denies read-only viewers before writing recommendation status', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });

    const res = await buildApp().request(`/security/recommendations/rec-1/${action}`, {
      method: 'POST',
    });

    expect(res.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('allows callers with devices:write and records the status event', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'write' }],
      allowedSiteIds: undefined,
    });
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    } as never);

    const res = await buildApp().request(`/security/recommendations/rec-1/${action}`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});
