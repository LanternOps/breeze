import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
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
  authMiddleware: vi.fn((c, next) => {
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
  requireScope: vi.fn(() => async (_c, next) => next())
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
});
