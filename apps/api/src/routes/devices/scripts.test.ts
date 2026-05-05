import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn()
  }
}));

vi.mock('../../db/schema', () => ({
  scriptExecutions: {
    id: 'id',
    scriptId: 'scriptId',
    status: 'status',
    exitCode: 'exitCode',
    stdout: 'stdout',
    stderr: 'stderr',
    errorMessage: 'errorMessage',
    startedAt: 'startedAt',
    completedAt: 'completedAt',
    createdAt: 'createdAt',
    deviceId: 'deviceId'
  },
  scripts: {
    id: 'id',
    name: 'name'
  }
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123'
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    if (resource === 'scripts' && action === 'read' && c.req.header('x-deny-scripts-read') === 'true') {
      return c.json({ error: 'Permission denied' }, 403);
    }
    if (c.req.header('x-site-restricted') === 'true') {
      c.set('permissions', {
        permissions: [{ resource, action }],
        partnerId: null,
        orgId: 'org-123',
        roleId: 'role-123',
        scope: 'organization',
        allowedSiteIds: ['site-allowed']
      });
    }
    return next();
  })
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgCheck: vi.fn()
}));

import { scriptsRoutes } from './scripts';
import { db } from '../../db';
import { getDeviceWithOrgCheck } from './helpers';

describe('device scripts routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', scriptsRoutes);
  });

  it('requires scripts.read before returning script output history', async () => {
    const res = await app.request('/devices/device-1/scripts', {
      method: 'GET',
      headers: { Authorization: 'Bearer token', 'x-deny-scripts-read': 'true' }
    });

    expect(res.status).toBe(403);
    expect(getDeviceWithOrgCheck).not.toHaveBeenCalled();
  });

  it('returns script execution history for an accessible device', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce({
      id: 'device-1',
      orgId: 'org-123',
      hostname: 'host-1'
    } as never);

    const executionRows = [
      {
        id: 'exec-1',
        scriptId: 'script-1',
        scriptName: 'Collect Inventory',
        status: 'completed',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        errorMessage: null,
        startedAt: new Date('2026-02-08T00:00:00.000Z'),
        completedAt: new Date('2026-02-08T00:00:03.000Z'),
        createdAt: new Date('2026-02-08T00:00:00.000Z')
      }
    ];

    const limit = vi.fn().mockResolvedValue(executionRows);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    const leftJoin = vi.fn().mockReturnValue({ where });
    const from = vi.fn().mockReturnValue({ leftJoin });

    vi.mocked(db.select).mockReturnValueOnce({ from } as never);

    const res = await app.request('/devices/device-1/scripts', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: 'exec-1',
      scriptId: 'script-1',
      scriptName: 'Collect Inventory',
      status: 'completed',
      exitCode: 0
    });
    expect(body.data[0].startedAt).toBe('2026-02-08T00:00:00.000Z');
    expect(body.data[0].completedAt).toBe('2026-02-08T00:00:03.000Z');
    expect(getDeviceWithOrgCheck).toHaveBeenCalledWith('device-1', expect.any(Object));
    expect(limit).toHaveBeenCalledWith(50);
  });

  it('returns 404 when the device is not accessible', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(null as never);

    const res = await app.request('/devices/device-missing/scripts', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(404);
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });

  it('denies script execution history when the device is outside the caller site restriction', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce({
      id: 'device-1',
      orgId: 'org-123',
      hostname: 'host-1',
      siteId: 'site-denied'
    } as never);

    const res = await app.request('/devices/device-1/scripts', {
      method: 'GET',
      headers: { Authorization: 'Bearer token', 'x-site-restricted': 'true' }
    });

    expect(res.status).toBe(403);
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });
});
