import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { requirePermissionMock } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
  },
  agentLogs: {
    deviceId: 'agentLogs.deviceId',
    timestamp: 'agentLogs.timestamp',
    level: 'agentLogs.level',
    component: 'agentLogs.component',
    message: 'agentLogs.message',
    fields: 'agentLogs.fields',
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1' },
      scope: 'organization',
      orgId: 'org-1',
      accessibleOrgIds: ['org-1'],
      canAccessOrg: (orgId: string) => orgId === 'org-1',
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: requirePermissionMock,
}));

import { db } from '../../db';
import { watchdogLogsRoutes } from './watchdogLogs';

const registeredPermissionCalls = [...requirePermissionMock.mock.calls];

describe('watchdog log routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', watchdogLogsRoutes);
  });

  it('requires explicit device read permission', () => {
    expect(registeredPermissionCalls).toContainEqual(['devices', 'read']);
  });

  it('redacts legacy raw secrets before returning watchdog logs', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'device-1', orgId: 'org-1' }]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([{
                  id: 'log-1',
                  deviceId: 'device-1',
                  component: 'watchdog.service',
                  message: 'restart failed token=raw-token',
                  fields: { apiKey: 'raw-key', nested: { password: 'raw-password' } },
                  timestamp: new Date('2026-05-01T00:00:00.000Z'),
                }]),
              }),
            }),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ total: 1 }]),
        }),
      } as any);

    const res = await app.request('/devices/device-1/watchdog-logs', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logs[0].message).toBe('restart failed token=[REDACTED]');
    expect(body.logs[0].fields).toEqual({
      apiKey: '[REDACTED]',
      nested: { password: '[REDACTED]' },
    });
  });
});
