import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../db')>(),
  db: { select: vi.fn() },
}));

vi.mock('../../middleware/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../middleware/auth')>(),
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1' },
      scope: 'organization',
      orgId: 'org-1',
      accessibleOrgIds: ['org-1'],
      canAccessOrg: () => true,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    c.set('permissions', { permissions: [], allowedSiteIds: undefined });
    return next();
  }),
}));

vi.mock('./helpers', async (importOriginal) => ({
  ...await importOriginal<typeof import('./helpers')>(),
  getDeviceWithOrgAndSiteCheck: vi.fn(async () => ({
    id: 'device-1', orgId: 'org-1', siteId: 'site-1',
  })),
}));

vi.mock('./core', async () => {
  const { Hono } = await import('hono');
  return { coreRoutes: new Hono() };
});

import { db } from '../../db';
import { deviceRoutes } from './index';

describe('device health route mounting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    } as never);
  });

  it('reaches the mounted health reader through the assembled devices router', async () => {
    const app = new Hono();
    app.route('/devices', deviceRoutes);

    const response = await app.request('/devices/device-1/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'unknown', observation: null });
  });
});
