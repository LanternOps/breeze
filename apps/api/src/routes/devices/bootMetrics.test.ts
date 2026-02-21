import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  deviceBootMetrics: {
    deviceId: 'device_id',
    bootTimestamp: 'boot_timestamp',
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123' },
      scope: 'organization',
      orgId: 'org-123',
      canAccessOrg: () => true,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgCheck: vi.fn(),
}));

vi.mock('../../services/commandQueue', () => ({
  executeCommand: vi.fn(),
}));

import { db } from '../../db';
import { getDeviceWithOrgCheck } from './helpers';
import { bootMetricsRoutes } from './bootMetrics';

describe('boot metrics routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', bootMetricsRoutes);
  });

  it('returns startup items with normalized itemId values', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({
      id: 'device-1',
      status: 'online',
      orgId: 'org-123',
    } as never);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              bootTimestamp: new Date('2026-02-21T10:00:00.000Z'),
              startupItems: [{
                name: 'Updater',
                type: 'service',
                path: '/usr/bin/updater',
                enabled: true,
                cpuTimeMs: 0,
                diskIoBytes: 0,
                impactScore: 0,
              }],
              startupItemCount: 1,
            }]),
          }),
        }),
      }),
    } as never);

    const res = await app.request('/devices/device-1/startup-items', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalItems).toBe(1);
    expect(body.items[0].itemId).toBe('service|/usr/bin/updater');
  });

  it('returns 409 when startup-item selector is ambiguous', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({
      id: 'device-1',
      status: 'online',
      orgId: 'org-123',
    } as never);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              bootTimestamp: new Date('2026-02-21T10:00:00.000Z'),
              startupItems: [
                {
                  name: 'Updater',
                  type: 'service',
                  path: '/usr/bin/updater',
                  enabled: true,
                  cpuTimeMs: 0,
                  diskIoBytes: 0,
                  impactScore: 0,
                },
                {
                  name: 'Updater',
                  type: 'run_key',
                  path: 'HKCU:Updater',
                  enabled: true,
                  cpuTimeMs: 0,
                  diskIoBytes: 0,
                  impactScore: 0,
                },
              ],
              startupItemCount: 2,
            }]),
          }),
        }),
      }),
    } as never);

    const res = await app.request('/devices/device-1/startup-items/Updater/disable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ reason: 'test' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('ambiguous');
    expect(body.candidates).toHaveLength(2);
  });
});

