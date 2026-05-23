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

// Wake-on-LAN brings a long transitive import chain through the API surface
// (commands.ts -> wakeOnLan.ts -> agentWs.ts -> remoteAccessPolicy.ts ->
// configurationPolicy.ts -> the full config-policy schema set; and
// agentWs.ts -> discoveryWorker.ts -> networkBaseline.ts -> the enum surface).
// Stubbing every table by name turns into a moving target — partial-mock via
// importOriginal so the real schema satisfies the transitive imports, while
// the assertions in this file continue to use the in-test mock infrastructure
// that doesn't read these tables at all.
vi.mock('../../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/schema')>();
  return { ...actual };
});

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

vi.mock('../../services/wakeOnLan', () => ({
  dispatchWake: vi.fn(),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: vi.fn(() => '127.0.0.1'),
}));

import { commandsRoutes } from './commands';
import { db } from '../../db';
import { getDeviceWithOrgCheck } from './helpers';
import { writeRouteAudit } from '../../services/auditEvents';
import { dispatchWake } from '../../services/wakeOnLan';

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

    it('bulk refresh_inventory dedups already-pending devices, skips silently (caught by @xxiaoxiong on #831)', async () => {
      // Two devices: A has a pending refresh_inventory already, B does not.
      // Expected: A is silently skipped (not added to `failed`), B gets a
      // new pending row. The single-device endpoint (#856) returns 409
      // on duplicate; the bulk path can't 409 per-device, so silent skip
      // is the right behavior — already-queued isn't an error.
      const deviceA = '11111111-1111-1111-1111-111111111111';
      const deviceB = '22222222-2222-2222-2222-222222222222';

      vi.mocked(getDeviceWithOrgCheck)
        .mockResolvedValueOnce({ id: deviceA, orgId: 'org-123', hostname: 'a', status: 'online' } as never)
        .mockResolvedValueOnce({ id: deviceB, orgId: 'org-123', hostname: 'b', status: 'online' } as never);

      // Dedup pre-check: A returns an existing pending row, B returns empty.
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: 'cmd-existing-a' }])
            })
          })
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as never);

      // Insert only fires for B.
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'cmd-new-b',
            deviceId: deviceB,
            type: 'refresh_inventory',
            status: 'pending',
            createdAt: new Date()
          }])
        })
      } as never);

      const res = await app.request('/devices/bulk/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          deviceIds: [deviceA, deviceB],
          type: 'refresh_inventory'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.commands).toHaveLength(1);
      expect(body.commands[0].deviceId).toBe(deviceB);
      // A was skipped silently — NOT in failed (already-pending isn't a failure).
      expect(body.failed).not.toContain(deviceA);
      // Insert was called exactly once (for B), not twice.
      expect(vi.mocked(db.insert)).toHaveBeenCalledTimes(1);
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

    describe('bulk-wake (type=wake)', () => {
      const onlineDevice = (id: string) =>
        ({ id, orgId: 'org-123', status: 'online', hostname: `host-${id.slice(0, 4)}` } as never);

      it('iterates dispatchWake per device and returns per-device outcomes with a shared bulkId', async () => {
        // 3 devices: 2 wake-able, 1 with no relay
        vi.mocked(getDeviceWithOrgCheck)
          .mockResolvedValueOnce(onlineDevice('11111111-1111-1111-1111-111111111111'))
          .mockResolvedValueOnce(onlineDevice('22222222-2222-2222-2222-222222222222'))
          .mockResolvedValueOnce(onlineDevice('33333333-3333-3333-3333-333333333333'));

        vi.mocked(dispatchWake)
          .mockResolvedValueOnce({
            ok: true,
            commandId: 'cmd-1',
            wakeAttemptId: 'wake-1',
            targetDeviceId: '11111111-1111-1111-1111-111111111111',
            targetHostname: 'host-1111',
            relayDeviceId: 'relay-1',
            relayHostname: 'relay-host-1',
            network: '10.10.10.0',
            broadcast: '10.10.10.255',
            maskSource: 'agent',
            macs: ['aa:bb:cc:dd:ee:01'],
          })
          .mockResolvedValueOnce({
            ok: false,
            code: 'NO_RELAY',
            message: 'No online peer agent is available at the target\'s site and subnet to relay the Wake-on-LAN packet.',
          })
          .mockResolvedValueOnce({
            ok: true,
            commandId: 'cmd-3',
            wakeAttemptId: 'wake-3',
            targetDeviceId: '33333333-3333-3333-3333-333333333333',
            targetHostname: 'host-3333',
            relayDeviceId: 'relay-2',
            relayHostname: 'relay-host-2',
            network: '10.10.20.0',
            broadcast: '10.10.20.255',
            maskSource: 'agent',
            macs: ['aa:bb:cc:dd:ee:03'],
          });

        const res = await app.request('/devices/bulk/commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({
            deviceIds: [
              '11111111-1111-1111-1111-111111111111',
              '22222222-2222-2222-2222-222222222222',
              '33333333-3333-3333-3333-333333333333',
            ],
            type: 'wake',
          }),
        });

        expect(res.status).toBe(202);
        const body = await res.json();
        expect(body.bulkId).toMatch(/^[0-9a-f-]{36}$/);
        expect(body.succeeded).toHaveLength(2);
        expect(body.failed).toHaveLength(1);
        expect(body.failed[0]).toMatchObject({
          deviceId: '22222222-2222-2222-2222-222222222222',
          code: 'NO_RELAY',
        });

        // Every dispatchWake call received the same bulkId so audit
        // rows can be correlated to one user click.
        const calls = vi.mocked(dispatchWake).mock.calls;
        expect(calls).toHaveLength(3);
        const bulkIds = new Set(calls.map(([, , opts]) => (opts as any).bulkId));
        expect(bulkIds.size).toBe(1);
        expect(bulkIds.has(body.bulkId)).toBe(true);
      });

      it('returns DECOMMISSIONED for decommissioned devices without calling dispatchWake', async () => {
        vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(
          { id: '11111111-1111-1111-1111-111111111111', orgId: 'org-123', status: 'decommissioned', hostname: 'host-1111' } as never,
        );

        const res = await app.request('/devices/bulk/commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({
            deviceIds: ['11111111-1111-1111-1111-111111111111'],
            type: 'wake',
          }),
        });

        expect(res.status).toBe(202);
        const body = await res.json();
        expect(body.succeeded).toHaveLength(0);
        expect(body.failed).toEqual([
          {
            deviceId: '11111111-1111-1111-1111-111111111111',
            code: 'DECOMMISSIONED',
            message: 'Cannot wake a decommissioned device.',
          },
        ]);
        expect(vi.mocked(dispatchWake)).not.toHaveBeenCalled();
      });

      it('returns TARGET_NOT_FOUND when getDeviceWithOrgCheck filters out a cross-org device', async () => {
        // null = either not found OR partner-scope access denied. Either way,
        // partner-scope safety: dispatchWake is never invoked.
        vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(null as never);

        const res = await app.request('/devices/bulk/commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({
            deviceIds: ['11111111-1111-1111-1111-111111111111'],
            type: 'wake',
          }),
        });

        expect(res.status).toBe(202);
        const body = await res.json();
        expect(body.failed[0]).toMatchObject({
          deviceId: '11111111-1111-1111-1111-111111111111',
          code: 'TARGET_NOT_FOUND',
        });
        expect(vi.mocked(dispatchWake)).not.toHaveBeenCalled();
      });

      it('schema rejects deviceIds.length > 500 (BULK_COMMAND_MAX_DEVICES cap)', async () => {
        const tooManyIds = Array.from({ length: 501 }, (_, i) => {
          const hex = i.toString(16).padStart(12, '0');
          return `00000000-0000-0000-0000-${hex}`;
        });
        const res = await app.request('/devices/bulk/commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ deviceIds: tooManyIds, type: 'wake' }),
        });
        expect(res.status).toBe(400);
        expect(vi.mocked(getDeviceWithOrgCheck)).not.toHaveBeenCalled();
        expect(vi.mocked(dispatchWake)).not.toHaveBeenCalled();
      });

      it('schema accepts type=wake', async () => {
        // Sanity check that the enum is in fact extended; the dispatchWake
        // path is mocked to a single failure to avoid setting up successful
        // returns — we only care that validation passes.
        vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(
          onlineDevice('11111111-1111-1111-1111-111111111111'),
        );
        vi.mocked(dispatchWake).mockResolvedValueOnce({
          ok: false,
          code: 'NO_MACS',
          message: 'no mac',
        });

        const res = await app.request('/devices/bulk/commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({
            deviceIds: ['11111111-1111-1111-1111-111111111111'],
            type: 'wake',
          }),
        });
        expect(res.status).toBe(202);
      });
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

    it('queues a refresh_inventory command as a pending row when none exists', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce({
        id: 'device-a',
        orgId: 'org-123',
        hostname: 'host-a',
        status: 'online'
      } as never);

      // Dedup pre-check: no existing pending refresh_inventory for this device.
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as never);

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'cmd-refresh',
            deviceId: 'device-a',
            type: 'refresh_inventory',
            status: 'pending',
            createdAt: new Date()
          }])
        })
      } as never);

      const res = await app.request('/devices/device-a/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ type: 'refresh_inventory' })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.type).toBe('refresh_inventory');
      expect(body.status).toBe('pending');
    });

    it('rejects a duplicate refresh_inventory with 409 when one is already pending (#830)', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce({
        id: 'device-a',
        orgId: 'org-123',
        hostname: 'host-a',
        status: 'online'
      } as never);

      // Dedup pre-check: an existing pending refresh_inventory blocks a new one.
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'cmd-existing' }])
          })
        })
      } as never);

      const res = await app.request('/devices/device-a/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ type: 'refresh_inventory' })
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('ALREADY_PENDING');
      expect(body.commandId).toBe('cmd-existing');
      // Crucial: no new row was queued.
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('does NOT apply dedup pre-check for non-refresh commands (reboot still inserts directly)', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce({
        id: 'device-a',
        orgId: 'org-123',
        hostname: 'host-a',
        status: 'online'
      } as never);

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'cmd-reboot',
            deviceId: 'device-a',
            type: 'reboot',
            status: 'pending',
            createdAt: new Date()
          }])
        })
      } as never);

      const res = await app.request('/devices/device-a/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ type: 'reboot' })
      });

      expect(res.status).toBe(201);
      // Reboot/shutdown are self-limiting (device goes away), so the dedup
      // check is intentionally scoped to refresh_inventory only.
      expect(db.select).not.toHaveBeenCalled();
    });

    it('rejects an unknown command type with 400', async () => {
      const res = await app.request('/devices/device-a/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ type: 'definitely_not_a_command' })
      });

      expect(res.status).toBe(400);
      expect(vi.mocked(getDeviceWithOrgCheck)).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
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

  describe('POST /devices/:id/auto-update', () => {
    it('queues set_auto_update command when enabled=true', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce({
        id: 'device-a',
        orgId: 'org-123',
        hostname: 'test-host',
        status: 'online'
      } as never);

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'cmd-456',
            deviceId: 'device-a',
            type: 'set_auto_update',
            status: 'pending',
            payload: { enabled: true },
            createdAt: new Date()
          }])
        })
      } as never);

      const res = await app.request('/devices/device-a/auto-update', {
        method: 'POST',
        headers: { 
          Authorization: 'Bearer token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ enabled: true })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('cmd-456');
      expect(body.deviceId).toBe('device-a');
      expect(body.type).toBe('set_auto_update');
      expect(body.status).toBe('pending');
      expect(body.createdAt).toBeDefined();  // Date handling in response
      expect(db.insert).toHaveBeenCalled();
    });

    it('rejects command for decommissioned device', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce({
        id: 'device-a',
        orgId: 'org-123',
        status: 'decommissioned'
      } as never);

      const res = await app.request('/devices/device-a/auto-update', {
        method: 'POST',
        headers: { 
          Authorization: 'Bearer token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ enabled: true })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('decommissioned');

    });
  });

  });
});
