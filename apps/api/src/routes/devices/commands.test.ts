import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn()
  }
}));

vi.mock('../../db/schema', () => ({
  deviceCommands: { id: 'id', deviceId: 'deviceId', createdAt: 'createdAt' },
  devices: { id: 'id' }
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
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  getDeviceWithOrgCheck: vi.fn()
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

import { commandsRoutes } from './commands';
import { db } from '../../db';
import { getDeviceWithOrgCheck } from './helpers';

describe('device commands routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', commandsRoutes);
  });

  describe('POST /devices/bulk/commands', () => {
    it('queues commands for accessible, non-decommissioned devices', async () => {
      vi.mocked(getDeviceWithOrgCheck)
        .mockResolvedValueOnce({ id: 'device-a', orgId: 'org-123', status: 'online', hostname: 'host-a' } as never)
        .mockResolvedValueOnce({ id: 'device-b', orgId: 'org-123', status: 'decommissioned', hostname: 'host-b' } as never);

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'cmd-1',
            deviceId: '11111111-1111-1111-1111-111111111111',
            type: 'reboot',
            status: 'pending',
            createdAt: new Date()
          }])
        })
      } as never);

      const res = await app.request('/devices/bulk/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          deviceIds: ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'],
          type: 'reboot'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.commands).toHaveLength(1);
      expect(body.failed).toEqual(['22222222-2222-2222-2222-222222222222']);
    });

    it('rejects script command requests without scriptId', async () => {
      const res = await app.request('/devices/bulk/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          deviceIds: ['11111111-1111-1111-1111-111111111111'],
          type: 'script',
          payload: {}
        })
      });

      expect(res.status).toBe(400);
      expect(vi.mocked(getDeviceWithOrgCheck)).not.toHaveBeenCalled();
    });
  });

  describe('POST /devices/:id/maintenance', () => {
    it('enables maintenance mode for eligible devices', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce({
        id: 'device-a',
        orgId: 'org-123',
        hostname: 'host-a',
        status: 'online'
      } as never);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'device-a',
              hostname: 'host-a',
              status: 'maintenance'
            }])
          })
        })
      } as never);

      const res = await app.request('/devices/device-a/maintenance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ enable: true, durationHours: 2 })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.device.status).toBe('maintenance');
    });

    it('rejects maintenance mode changes for decommissioned devices', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce({
        id: 'device-a',
        orgId: 'org-123',
        hostname: 'host-a',
        status: 'decommissioned'
      } as never);

      const res = await app.request('/devices/device-a/maintenance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ enable: true })
      });

      expect(res.status).toBe(400);
    });
  });
});
