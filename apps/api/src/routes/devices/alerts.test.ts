import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { requirePermissionMock, siteDenied } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(() => async (_c: any, next: any) => next()),
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
  requirePermission: requirePermissionMock,
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: siteDenied,
}));

import { db } from '../../db';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { alertsRoutes } from './alerts';

const registeredPermissionCalls = [...requirePermissionMock.mock.calls];

describe('device alert routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', alertsRoutes);
  });

  it('requires explicit device read permission', () => {
    expect(registeredPermissionCalls).toContainEqual(['devices', 'read']);
  });

  it('denies alerts when site scope excludes the device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);

    const res = await app.request('/devices/device-1/alerts', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('fills leftover {{device}} tokens from the device display name', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      id: 'device-1',
      hostname: 'DESKTOP-8UG65K6',
      displayName: 'Front desk',
    } as never);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([
        {
          id: 'alert-1',
          title: '{{device}} offline',
          message: '{{device}} has been offline',
          severity: 'high',
          status: 'active',
          triggeredAt: new Date('2026-09-16T00:00:00.000Z'),
          acknowledgedAt: null,
          resolvedAt: null,
          ruleName: 'Offline',
          templateName: 'Device Offline',
        },
      ]),
    } as never);

    const res = await app.request('/devices/device-1/alerts', {
      headers: { Authorization: 'Bearer token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ summary: string; message: string }> };
    expect(body.data[0]?.summary).toBe('Front desk offline');
    expect(body.data[0]?.message).toBe('Front desk has been offline');
  });
});
