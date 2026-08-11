import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { requirePermissionMock, requireMfaMock, siteDenied } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfaMock: vi.fn(() => async (_c: any, next: any) => next()),
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
      orgCondition: () => undefined,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: requirePermissionMock,
  requireMfa: requireMfaMock,
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: siteDenied,
}));

vi.mock('../../services/warrantyWorker', () => ({
  queueWarrantySyncForDevice: vi.fn(),
}));

import { db } from '../../db';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { queueWarrantySyncForDevice } from '../../services/warrantyWorker';
import { warrantyRoutes } from './warranty';

const registeredPermissionCalls = [...requirePermissionMock.mock.calls];
const registeredMfaCallCount = requireMfaMock.mock.calls.length;

describe('device warranty routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', warrantyRoutes);
  });

  it('registers read and write permission gates', () => {
    expect(registeredPermissionCalls).toContainEqual(['devices', 'read']);
    expect(registeredPermissionCalls).toContainEqual(['devices', 'write']);
    expect(registeredMfaCallCount).toBe(1);
  });

  it('denies warranty reads when site scope excludes the device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);

    const res = await app.request('/devices/device-1/warranty', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('denies warranty refresh when site scope excludes the device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);

    const res = await app.request('/devices/device-1/warranty/refresh', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    expect(queueWarrantySyncForDevice).not.toHaveBeenCalled();
  });

  it('queues a manual refresh with force so the VM skip cannot dead-end it (#3201)', async () => {
    // Pins the route half of the escape hatch: without { force: true } here, a
    // device flagged virtual never advances lastSyncAt and the warranty card
    // polls a "queued" refresh that never completes — the exact dead-end the
    // review blocked on. The service half is pinned in warrantySync.test.ts.
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: 'device-1', orgId: 'org-123' } as never);

    const res = await app.request('/devices/device-1/warranty/refresh', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(queueWarrantySyncForDevice).toHaveBeenCalledWith('device-1', { force: true });
  });
});
