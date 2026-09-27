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
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: Symbol('SITE_ACCESS_DENIED'),
}));

vi.mock('../../services/commandQueue', () => ({
  executeCommand: vi.fn(),
}));

vi.mock('../../services/aiRemoteToolsPolicy', () => ({
  REMOTE_TOOLS_DISABLED_BY_POLICY: 'REMOTE_TOOLS_DISABLED_BY_POLICY',
  checkDeviceRemoteToolsPolicy: vi.fn(async () => ({ allowed: true })),
}));

import { db } from '../../db';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { bootMetricsRoutes } from './bootMetrics';
import { executeCommand } from '../../services/commandQueue';
import { checkDeviceRemoteToolsPolicy } from '../../services/aiRemoteToolsPolicy';

describe('boot metrics routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', bootMetricsRoutes);
  });

  it('returns startup items with normalized itemId values', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
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
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
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

  it('denies startup-item reads when site scope excludes the device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);

    const res = await app.request('/devices/device-1/startup-items', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  // Startup-item actions are the same class as /system-tools and
  // honour the per-device remote-tools policy like it does.
  it.each(['disable', 'enable'])('refuses startup-item %s when the remote-tools policy is off, before any dispatch', async (action) => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: 'device-1', status: 'online', orgId: 'org-123' } as never);
    vi.mocked(checkDeviceRemoteToolsPolicy).mockResolvedValueOnce({ allowed: false, reason: 'Remote tools is disabled by policy "Locked"' });

    const res = await app.request(`/devices/device-1/startup-items/Updater/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ reason: 'test' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('REMOTE_TOOLS_DISABLED_BY_POLICY');
    expect(body.error).toContain('Locked');
    expect(checkDeviceRemoteToolsPolicy).toHaveBeenCalledWith('device-1');
    expect(db.select).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('does not consult the policy before the tenant check (another tenant\'s device reads as not found)', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null as never);
    const res = await app.request('/devices/device-1/startup-items/Updater/disable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ reason: 'test' }),
    });
    expect(res.status).toBe(404);
    expect(checkDeviceRemoteToolsPolicy).not.toHaveBeenCalled();
  });
});
