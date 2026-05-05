import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn()
  }
}));

vi.mock('../../db/schema', () => ({
  deviceCommands: {
    id: 'id',
    deviceId: 'deviceId',
    type: 'type',
    payload: 'payload',
    result: 'result',
    createdAt: 'createdAt'
  },
  devices: { id: 'id' }
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
    if (resource === 'devices' && action === 'read' && c.req.header('x-deny-read') === 'true') {
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
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
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
import { writeRouteAudit } from '../../services/auditEvents';

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

    it('rejects generic script command requests before device lookup', async () => {
      const res = await app.request('/devices/bulk/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          deviceIds: ['11111111-1111-1111-1111-111111111111'],
          type: 'script',
          payload: {
            scriptId: '33333333-3333-3333-3333-333333333333',
            language: 'bash',
            content: 'whoami'
          }
        })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('scripts endpoint');
      expect(vi.mocked(getDeviceWithOrgCheck)).not.toHaveBeenCalled();
    });
  });

  describe('POST /devices/:id/commands', () => {
    it('writes sanitized command payload details to audit logs', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce({
        id: 'device-a',
        orgId: 'org-123',
        hostname: 'host-a',
        status: 'online'
      } as never);

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'cmd-raw',
            deviceId: 'device-a',
            type: 'collect_evidence',
            status: 'pending',
            createdAt: new Date()
          }])
        })
      } as never);

      const res = await app.request('/devices/device-a/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          type: 'collect_evidence',
          payload: {
            path: '/tmp/secret.txt',
            content: 'super-secret-file-body',
            token: 'abc123'
          }
        })
      });

      expect(res.status).toBe(201);
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        details: expect.objectContaining({
          deviceId: 'device-a',
          commandId: 'cmd-raw',
          type: 'collect_evidence',
          payload: expect.objectContaining({
            path: '/tmp/secret.txt',
            content: expect.objectContaining({ redacted: true })
          })
        })
      }));
      const auditPayload = JSON.stringify(vi.mocked(writeRouteAudit).mock.calls[0]?.[1]);
      expect(auditPayload).not.toContain('super-secret-file-body');
      expect(auditPayload).not.toContain('abc123');
    });

    it('rejects generic script command requests with caller-controlled content', async () => {
      const res = await app.request('/devices/device-a/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          type: 'script',
          payload: {
            scriptId: '33333333-3333-3333-3333-333333333333',
            language: 'bash',
            content: 'id',
            timeoutSeconds: 5,
            runAs: 'root'
          }
        })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('scripts endpoint');
      expect(vi.mocked(getDeviceWithOrgCheck)).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
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

  describe('GET /devices/:id/commands/:commandId', () => {
    it('requires devices.read before returning command details', async () => {
      const res = await app.request('/devices/device-a/commands/cmd-123', {
        headers: { Authorization: 'Bearer token', 'x-deny-read': 'true' }
      });

      expect(res.status).toBe(403);
      expect(getDeviceWithOrgCheck).not.toHaveBeenCalled();
    });

    it('returns a single command for the device', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce({
        id: 'device-a',
        orgId: 'org-123',
        hostname: 'host-a',
        status: 'online'
      } as never);

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'cmd-123',
              deviceId: 'device-a',
              type: 'script',
              status: 'sent',
              payload: {
                content: 'Write-Host secret',
                parameters: { password: 'hunter2' }
              },
              result: { status: 'completed', stdout: 'token=abc123' }
            }])
          })
        })
      } as never);

      const res = await app.request('/devices/device-a/commands/cmd-123', {
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe('cmd-123');
      expect(body.data.status).toBe('sent');
      expect(JSON.stringify(body.data)).not.toContain('Write-Host secret');
      expect(JSON.stringify(body.data)).not.toContain('hunter2');
      expect(JSON.stringify(body.data)).not.toContain('abc123');
    });
  });

  describe('GET /devices/:id/commands', () => {
    it('denies command history when the device is outside the caller site restriction', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce({
        id: 'device-a',
        orgId: 'org-123',
        hostname: 'host-a',
        siteId: 'site-denied',
        status: 'online'
      } as never);

      const res = await app.request('/devices/device-a/commands', {
        headers: { Authorization: 'Bearer token', 'x-site-restricted': 'true' }
      });

      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
    });
  });
});
