import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { siteDenied } = vi.hoisted(() => ({
  siteDenied: Symbol('SITE_ACCESS_DENIED'),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123' },
      scope: 'organization',
      orgId: 'org-123',
      canAccessOrg: (orgId: string) => orgId === 'org-123',
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    c.set('permissions', {
      permissions: [{ resource: 'devices', action: 'execute' }],
      allowedSiteIds: c.req.header('x-site-restricted') === 'true' ? ['site-allowed'] : undefined,
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: siteDenied,
}));

vi.mock('../../services/commandQueue', () => ({
  executeCommand: vi.fn(),
}));

import { db } from '../../db';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { executeCommand } from '../../services/commandQueue';
import { diagnoseRoutes } from './diagnose';

describe('device diagnose route', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', diagnoseRoutes);
  });

  it('denies diagnose when site scope excludes the device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);

    const res = await app.request('/devices/device-1/diagnose', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'x-site-restricted': 'true' },
    });

    expect(res.status).toBe(403);
    expect(executeCommand).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });
});
