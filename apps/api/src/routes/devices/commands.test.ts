import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// RMM-QA-176: ENABLE_2FA is a module constant (routes/auth/schemas.ts:10); the
// established way to flip it per test is a getter on a partial module mock
// (precedent: routes/auth/login.test.ts:271-280). T1 asserts it is TRUE by
// default so no later RED can be an "ENABLE_2FA=false" artefact.
const { enable2faState, authState } = vi.hoisted(() => ({
  enable2faState: { value: true },
  authState: {
    principalKind: 'user_session' as string,
    mfa: true as boolean,
    sid: 'sid-1' as string | undefined,
  },
}));

vi.mock('../../routes/auth/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/auth/schemas')>();
  return {
    ...actual,
    get ENABLE_2FA() {
      return enable2faState.value;
    },
  };
});

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
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

// PARTIAL mock (RMM-QA-176): requireMfa, hasSatisfiedMfa and
// isInteractiveUserSession must be the REAL implementations — the gates this
// suite now proves are exactly those three. Only the transport-ish middlewares
// (authMiddleware) and the two authorization stubs whose behaviour this suite
// drives by header (requireScope / requirePermission) stay mocked.
vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: vi.fn((c: any, next: any) => {
      c.set('auth', {
        // `principal` drives isInteractiveUserSession (middleware/auth.ts:64);
        // `token` drives hasSatisfiedMfa (middleware/auth.ts:886). API-key
        // contexts are built with `token: {}` (routes/mcpServer.ts:2246), which
        // is why T9 sets principalKind without touching `mfa`.
        principal: { kind: authState.principalKind, id: 'principal-1' },
        token: { mfa: authState.mfa, sid: authState.sid },
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
      // Production `requirePermission` ALWAYS populates `permissions`; the
      // canAccessDeviceSite helper fails closed when it is absent (T10), so the
      // mock must mirror that — set an unrestricted context by default, and add
      // a site restriction only when the test asks for one.
      c.set('permissions', {
        permissions: [{ resource, action }],
        partnerId: null,
        orgId: 'org-123',
        roleId: 'role-123',
        scope: 'organization',
        ...(c.req.header('x-site-restricted') === 'true'
          ? { allowedSiteIds: ['site-allowed'] }
          : {}),
      });
      return next();
    }),
  };
});

vi.mock('./helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./helpers')>()),
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

vi.mock('../../services/mfaStepUpGrant', async (importOriginal) => {
  // Partial: maintenanceResourceDigest stays REAL so the binding assertion in
  // T4 compares against the production canonicalization, not a stub.
  const actual = await importOriginal<typeof import('../../services/mfaStepUpGrant')>();
  return {
    ...actual,
    validateStepUpGrant: vi.fn(async () => true),
    consumeStepUpGrant: vi.fn(async () => true),
  };
});

vi.mock('../../services/authEpochs', () => ({
  getUserEpochs: vi.fn(async () => ({ authEpoch: 1, mfaEpoch: 1 })),
}));

import { commandsRoutes } from './commands';
import { db } from '../../db';
import { getDeviceWithOrgCheck } from './helpers';
import { writeRouteAudit } from '../../services/auditEvents';
import { dispatchWake } from '../../services/wakeOnLan';
import { consumeStepUpGrant, maintenanceResourceDigest, validateStepUpGrant } from '../../services/mfaStepUpGrant';

describe('device commands routes', () => {
  let app: Hono;

  beforeEach(() => {
    enable2faState.value = true;
    authState.principalKind = 'user_session';
    authState.mfa = true;
    authState.sid = 'sid-1';
    vi.clearAllMocks();
    // RMM-QA-176: vi.clearAllMocks() clears call HISTORY but not queued
    // `...Once` implementations. Several cases in this file now deny BEFORE the
    // device lookup (the interactive/MFA/step-up gates), leaving their
    // `mockResolvedValueOnce` unconsumed — which the NEXT test would then be
    // served, silently inverting its result. Reset the two mocks whose values
    // decide a route's outcome so every case starts from an empty queue.
    vi.mocked(getDeviceWithOrgCheck).mockReset();
    vi.mocked(db.transaction).mockReset();
    // Same hazard on the two grant mocks: a bulk case that denies BEFORE the
    // consume (the missing-grant and shadowed-route paths) leaves its
    // `mockResolvedValueOnce(false)` queued, and the next test to actually
    // reach the consume is served it. That silently inverted T4 (a 403 where a
    // 200 was expected) during Task 8's first RED run, masking the real
    // finding — reset both and restore the module-factory default explicitly.
    vi.mocked(validateStepUpGrant).mockReset().mockResolvedValue(true);
    vi.mocked(consumeStepUpGrant).mockReset().mockResolvedValue(true);
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
      expect(body.failed).toEqual([
        {
          deviceId: '22222222-2222-2222-2222-222222222222',
          code: 'DECOMMISSIONED',
          message: 'Cannot send commands to a decommissioned device.',
        },
      ]);
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
      // A was deduped — surfaced via `skipped` (NOT `failed`) so the caller
      // can say "1 queued, 1 already pending" instead of treating it as a
      // failure.
      expect(body.failed).toEqual([]);
      expect(body.skipped).toEqual([
        { deviceId: deviceA, code: 'ALREADY_PENDING', commandId: 'cmd-existing-a' },
      ]);
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

    it('marks site-denied devices as failed for bulk generic commands', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce({
        id: '11111111-1111-1111-1111-111111111111',
        orgId: 'org-123',
        hostname: 'host-a',
        siteId: 'site-denied',
        status: 'online',
      } as never);

      const res = await app.request('/devices/bulk/commands', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
          'x-site-restricted': 'true',
        },
        body: JSON.stringify({
          deviceIds: ['11111111-1111-1111-1111-111111111111'],
          type: 'reboot',
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.commands).toHaveLength(0);
      expect(body.failed).toEqual([
        {
          deviceId: '11111111-1111-1111-1111-111111111111',
          code: 'SITE_ACCESS_DENIED',
          message: 'Access to this site denied.',
        },
      ]);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('mixed batch: succeeds for allowed device and reports per-device failure for site-denied device', async () => {
      const allowedId = '11111111-1111-1111-1111-111111111111';
      const deniedId = '22222222-2222-2222-2222-222222222222';

      vi.mocked(getDeviceWithOrgCheck)
        .mockResolvedValueOnce({
          id: allowedId,
          orgId: 'org-123',
          hostname: 'allowed-host',
          siteId: 'site-allowed',
          status: 'online',
        } as never)
        .mockResolvedValueOnce({
          id: deniedId,
          orgId: 'org-123',
          hostname: 'denied-host',
          siteId: 'site-denied',
          status: 'online',
        } as never);

      // Insert only fires for the allowed device.
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'cmd-allowed',
            deviceId: allowedId,
            type: 'reboot',
            status: 'pending',
            createdAt: new Date(),
          }]),
        }),
      } as never);

      const res = await app.request('/devices/bulk/commands', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
          'x-site-restricted': 'true',
        },
        body: JSON.stringify({
          deviceIds: [allowedId, deniedId],
          type: 'reboot',
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      // The allowed device got a queued command.
      expect(body.commands).toHaveLength(1);
      expect(body.commands[0].deviceId).toBe(allowedId);
      // The denied device got a typed failure entry, not silent drop.
      expect(body.failed).toEqual([
        {
          deviceId: deniedId,
          code: 'SITE_ACCESS_DENIED',
          message: 'Access to this site denied.',
        },
      ]);
      // Exactly one insert — the denial short-circuited before insert for the
      // second device, but did NOT abort the batch.
      expect(db.insert).toHaveBeenCalledTimes(1);
    });

    it('mixed batch with denied FIRST: subsequent allowed device still gets queued (defends against early-abort refactor)', async () => {
      // Reverse-order companion to the test above. A future refactor that
      // does `if (anyDenied) return early` would pass the [allowed, denied]
      // case but fail this one — the allowed device is processed AFTER the
      // denial, so it would never reach the insert.
      const deniedId = '11111111-1111-1111-1111-111111111111';
      const allowedId = '22222222-2222-2222-2222-222222222222';

      vi.mocked(getDeviceWithOrgCheck)
        .mockResolvedValueOnce({
          id: deniedId,
          orgId: 'org-123',
          hostname: 'denied-host',
          siteId: 'site-denied',
          status: 'online',
        } as never)
        .mockResolvedValueOnce({
          id: allowedId,
          orgId: 'org-123',
          hostname: 'allowed-host',
          siteId: 'site-allowed',
          status: 'online',
        } as never);

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'cmd-allowed',
            deviceId: allowedId,
            type: 'reboot',
            status: 'pending',
            createdAt: new Date(),
          }]),
        }),
      } as never);

      const res = await app.request('/devices/bulk/commands', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
          'x-site-restricted': 'true',
        },
        body: JSON.stringify({
          deviceIds: [deniedId, allowedId],
          type: 'reboot',
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.commands).toHaveLength(1);
      expect(body.commands[0].deviceId).toBe(allowedId);
      expect(body.failed).toEqual([
        { deviceId: deniedId, code: 'SITE_ACCESS_DENIED', message: 'Access to this site denied.' },
      ]);
      expect(db.insert).toHaveBeenCalledTimes(1);
    });

    it('records INSERT_FAILED per-device when the insert throws and the batch continues', async () => {
      // Defends against a refactor that drops the try/catch around insert
      // and lets one device's DB error 500 the whole batch (losing every
      // prior success).
      const failingId = '11111111-1111-1111-1111-111111111111';
      const succeedingId = '22222222-2222-2222-2222-222222222222';

      vi.mocked(getDeviceWithOrgCheck)
        .mockResolvedValueOnce({ id: failingId, orgId: 'org-123', hostname: 'host-fail', status: 'online' } as never)
        .mockResolvedValueOnce({ id: succeedingId, orgId: 'org-123', hostname: 'host-ok', status: 'online' } as never);

      // First insert throws (constraint violation, pool exhaustion, etc.),
      // second succeeds.
      vi.mocked(db.insert)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(new Error('duplicate key value violates unique constraint')),
          }),
        } as never)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'cmd-ok',
              deviceId: succeedingId,
              type: 'reboot',
              status: 'pending',
              createdAt: new Date(),
            }]),
          }),
        } as never);

      const res = await app.request('/devices/bulk/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          deviceIds: [failingId, succeedingId],
          type: 'reboot',
        }),
      });

      // Status is still 201; INSERT_FAILED is a per-device failure, not a
      // batch-level error.
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.commands).toHaveLength(1);
      expect(body.commands[0].deviceId).toBe(succeedingId);
      expect(body.failed).toEqual([
        {
          deviceId: failingId,
          code: 'INSERT_FAILED',
          message: 'duplicate key value violates unique constraint',
        },
      ]);
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

      it('returns SITE_ACCESS_DENIED for site-denied wake targets without dispatching', async () => {
        vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce({
          id: '11111111-1111-1111-1111-111111111111',
          orgId: 'org-123',
          siteId: 'site-denied',
          status: 'online',
          hostname: 'host-1111',
        } as never);

        const res = await app.request('/devices/bulk/commands', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer token',
            'x-site-restricted': 'true',
          },
          body: JSON.stringify({
            deviceIds: ['11111111-1111-1111-1111-111111111111'],
            type: 'wake',
          }),
        });

        expect(res.status).toBe(202);
        const body = await res.json();
        expect(body.failed).toEqual([
          {
            deviceId: '11111111-1111-1111-1111-111111111111',
            code: 'SITE_ACCESS_DENIED',
            message: 'Access to this site denied.',
          },
        ]);
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

    it('denies single generic commands when site scope excludes the device', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce({
        id: 'device-a',
        orgId: 'org-123',
        hostname: 'host-a',
        siteId: 'site-denied',
        status: 'online',
      } as never);

      const res = await app.request('/devices/device-a/commands', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
          'x-site-restricted': 'true',
        },
        body: JSON.stringify({ type: 'reboot' }),
      });

      expect(res.status).toBe(403);
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  /**
   * tx stub for db.transaction: the lease service takes a FOR UPDATE lock, then
   * issues one UPDATE … RETURNING. `calls` gives tests the ordered trace so
   * "no write on denial" and "exactly one UPDATE" are real assertions.
   */
  function mockMaintenanceTx(row: Record<string, unknown> | null) {
    const calls: string[] = [];
    const captured: Array<Record<string, unknown>> = [];
    const txSelect = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({ for: vi.fn(async () => { calls.push('select-for-update'); return row ? [row] : []; }) })),
        })),
      })),
    }));
    const txUpdate = vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        captured.push(values);
        calls.push('update');
        return { where: vi.fn(() => ({ returning: vi.fn(async () => [{ ...row, ...values }]) })) };
      }),
    }));
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn({ select: txSelect, update: txUpdate }));
    return { calls, captured, txSelect, txUpdate };
  }

  describe('POST /devices/bulk/maintenance', () => {
    const GRANT = '22222222-2222-4222-8222-222222222222';
    const ids = {
      ok: '00000000-0000-4000-8000-00000000000a',
      missing: '00000000-0000-4000-8000-00000000000b',
      denied: '00000000-0000-4000-8000-00000000000c',
      quarantined: '00000000-0000-4000-8000-00000000000d',
      ok2: '00000000-0000-4000-8000-00000000000e',
    };
    const row = (id: string, over: Record<string, unknown> = {}) => ({
      id, orgId: 'org-123', hostname: `host-${id.slice(-1)}`, siteId: 'site-allowed',
      status: 'online', lastSeenAt: new Date(Date.now() - 60_000),
      maintenanceStartedAt: null, maintenanceUntil: null, maintenanceReason: null, maintenanceStartedBy: null,
      ...over,
    });
    const bulkPost = (body: unknown, headers: Record<string, string> = {}) =>
      app.request('/devices/bulk/maintenance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token', ...headers },
        body: JSON.stringify(body),
      });
    const validBody = (over: Record<string, unknown> = {}) => ({
      // NOTE the duplicate: the digest must be computed over the DEDUPED set.
      deviceIds: [ids.ok, ids.missing, ids.denied, ids.quarantined, ids.ok],
      reason: 'scheduled patching', durationHours: 2, stepUpGrant: GRANT, ...over,
    });

    function stubLookups() {
      vi.mocked(getDeviceWithOrgCheck).mockImplementation(async (id: string) => {
        if (id === ids.missing) return null as never;
        if (id === ids.denied) return row(id, { siteId: 'site-denied' }) as never;
        if (id === ids.quarantined) return row(id, { status: 'quarantined' }) as never;
        return row(id) as never;
      });
    }

    /**
     * Multi-row variant of mockMaintenanceTx: the bulk route locks each eligible
     * device in turn inside ONE transaction, so the stub must hand back a
     * DIFFERENT row per FOR UPDATE. Without this the "exactly one transaction"
     * control cannot discriminate — with a single eligible device, per-device
     * transactions and one batch transaction both call db.transaction once.
     */
    function mockBulkTx(rows: Array<Record<string, unknown>>) {
      const queue = [...rows];
      const calls: string[] = [];
      let current: Record<string, unknown> | null = null;
      const txSelect = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({
              for: vi.fn(async () => {
                calls.push('select-for-update');
                current = queue.shift() ?? null;
                return current ? [current] : [];
              }),
            })),
          })),
        })),
      }));
      const txUpdate = vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          calls.push('update');
          const locked = current;
          return { where: vi.fn(() => ({ returning: vi.fn(async () => [{ ...locked, ...values }]) })) };
        }),
      }));
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn({ select: txSelect, update: txUpdate }));
      return { calls };
    }

    it('validates the grant over the SORTED, DEDUPED device set and consumes it exactly once, after preflight', async () => {
      stubLookups();
      mockMaintenanceTx(row(ids.ok));
      const res = await bulkPost(validBody(), { 'x-site-restricted': 'true' });
      expect(res.status).toBe(200);
      const expectedDigest = maintenanceResourceDigest({
        deviceIds: [ids.ok, ids.missing, ids.denied, ids.quarantined],
        reason: 'scheduled patching', durationHours: 2,
      });
      expect(validateStepUpGrant).toHaveBeenCalledWith(GRANT, expect.objectContaining({ operation: 'device_maintenance', resourceDigest: expectedDigest }));
      expect(consumeStepUpGrant).toHaveBeenCalledTimes(1);
      expect(consumeStepUpGrant).toHaveBeenCalledWith(GRANT, expect.objectContaining({ resourceDigest: expectedDigest }));
    });

    // The digest canonicalizer dedupes internally, so a digest-only assertion
    // CANNOT prove the route deduped. These two do: the repeated id must cost
    // exactly one lookup and produce exactly one success.
    it('deduplicates the device set before the preflight loop, not just inside the digest', async () => {
      stubLookups();
      mockMaintenanceTx(row(ids.ok));
      const res = await bulkPost(validBody(), { 'x-site-restricted': 'true' });
      expect(res.status).toBe(200);
      expect(vi.mocked(getDeviceWithOrgCheck).mock.calls.map((c) => c[0])).toEqual([
        ids.ok, ids.missing, ids.denied, ids.quarantined,
      ]);
      const body = await res.json();
      expect(body.succeeded).toHaveLength(1);
    });

    it('reports per-device failures with codes and enters only the eligible devices, in ONE transaction', async () => {
      stubLookups();
      mockMaintenanceTx(row(ids.ok));
      const res = await bulkPost(validBody(), { 'x-site-restricted': 'true' });
      const body = await res.json();
      expect(body.succeeded.map((s: any) => s.deviceId)).toEqual([ids.ok]);
      expect(body.succeeded[0]).toMatchObject({ action: 'enable' });
      expect(body.failed.map((f: any) => [f.deviceId, f.code]).sort()).toEqual([
        [ids.denied, 'SITE_ACCESS_DENIED'],
        [ids.missing, 'TARGET_NOT_FOUND'],
        [ids.quarantined, 'STATE_CONFLICT'],
      ].sort());
      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it('applies a MULTI-device eligible set inside exactly ONE transaction', async () => {
      stubLookups();
      const { calls } = mockBulkTx([row(ids.ok), row(ids.ok2)]);
      const res = await bulkPost(validBody({ deviceIds: [ids.ok, ids.ok2] }), { 'x-site-restricted': 'true' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.succeeded.map((s: any) => s.deviceId)).toEqual([ids.ok, ids.ok2]);
      expect(calls).toEqual(['select-for-update', 'update', 'select-for-update', 'update']);
      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it('writes one audit row per succeeded device (per-resource trail, like bulk wake)', async () => {
      stubLookups();
      mockMaintenanceTx(row(ids.ok));
      await bulkPost(validBody(), { 'x-site-restricted': 'true' });
      const maintenanceAudits = vi.mocked(writeRouteAudit).mock.calls
        .filter(([, e]: any) => String(e.action).startsWith('device.maintenance.'));
      expect(maintenanceAudits).toHaveLength(1);
      expect(maintenanceAudits[0]![1]).toMatchObject({ action: 'device.maintenance.enable' });
    });

    it('returns 200 with all failures and NEVER burns the grant when no device is eligible', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(null as never);
      const res = await bulkPost(validBody());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.succeeded).toEqual([]);
      expect(body.failed).toHaveLength(4);
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('returns 403 STEP_UP_REQUIRED with no transaction when the consume loses a race', async () => {
      stubLookups();
      vi.mocked(consumeStepUpGrant).mockResolvedValueOnce(false);
      const res = await bulkPost(validBody());
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('returns 403 STEP_UP_REQUIRED before any lookup when the grant is missing', async () => {
      stubLookups();
      const res = await bulkPost(validBody({ stepUpGrant: undefined }));
      expect(res.status).toBe(403);
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('requires MFA unconditionally — this route is entry only', async () => {
      authState.mfa = false;
      const res = await bulkPost(validBody());
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it.each([[true], [false]])('denies an api_key principal with ENABLE_2FA=%s and no state change', async (twoFactorOn) => {
      // Everything else is staged for SUCCESS — lookups resolve, the tx stub is
      // armed, the grant validates — so the ONLY thing standing between this
      // machine principal and a written row is the interactive gate. With
      // ENABLE_2FA=false, hasSatisfiedMfa short-circuits to true for the
      // production `token: {}` shape, so requireMfa() would ADMIT this caller.
      enable2faState.value = twoFactorOn;
      authState.principalKind = 'api_key';
      authState.mfa = false;
      authState.sid = undefined;
      stubLookups();
      const { calls } = mockBulkTx([row(ids.ok)]);
      const res = await bulkPost(validBody(), { 'x-site-restricted': 'true' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Interactive user session required' });
      expect(db.transaction).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      expect(getDeviceWithOrgCheck).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    it('rejects a body over the shared device cap with 400 and no state change', async () => {
      const res = await bulkPost(validBody({ deviceIds: Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }));
      expect(res.status).toBe(400);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('is registered BEFORE /:id/maintenance so "bulk" is not read as a device id', async () => {
      stubLookups();
      mockMaintenanceTx(row(ids.ok));
      const res = await bulkPost(validBody(), { 'x-site-restricted': 'true' });
      // A 200 is half the proof: if /:id/maintenance shadowed this path, its
      // maintenanceModeSchema would 400 the bulk body before any lookup ran,
      // so the id assertion alone could not tell shadowing from success.
      expect(res.status).toBe(200);
      expect(vi.mocked(getDeviceWithOrgCheck).mock.calls.map((c) => c[0])).not.toContain('bulk');
    });
  });

  describe('POST /devices/:id/maintenance', () => {
    const deviceRow = (over: Record<string, unknown> = {}) => ({
      id: 'device-a', orgId: 'org-123', hostname: 'host-a', siteId: 'site-allowed',
      status: 'online', lastSeenAt: new Date(Date.now() - 60_000),
      maintenanceStartedAt: null, maintenanceUntil: null, maintenanceReason: null, maintenanceStartedBy: null,
      ...over,
    });
    const enterBody = (over: Record<string, unknown> = {}) => JSON.stringify({
      enable: true, reason: 'scheduled patching', durationHours: 2, stepUpGrant: '11111111-1111-4111-8111-111111111111', ...over,
    });
    const post = (body: string, headers: Record<string, string> = {}) =>
      app.request('/devices/device-a/maintenance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token', ...headers },
        body,
      });

    // ---- T1: precondition. Without this every later RED could be an
    // "ENABLE_2FA is off in tests" artefact rather than a real gate.
    it('runs with ENABLE_2FA true and the REAL MFA gate (precondition for every case below)', async () => {
      const { ENABLE_2FA } = await import('../../routes/auth/schemas');
      expect(ENABLE_2FA).toBe(true);
      const { requireMfa, hasSatisfiedMfa, isInteractiveUserSession } = await import('../../middleware/auth');
      expect(vi.isMockFunction(requireMfa)).toBe(false);
      expect(hasSatisfiedMfa({ token: { mfa: false } } as never)).toBe(false);
      expect(isInteractiveUserSession({ principal: { kind: 'api_key' } } as never)).toBe(false);
    });

    // ---- T2: non-assured session denied, zero writes.
    it('denies entry from a session that has not satisfied MFA, with no state change', async () => {
      authState.mfa = false;
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(deviceRow() as never);
      const res = await post(enterBody());
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
      expect(db.transaction).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    // ---- T3: grant required; missing and stale are indistinguishable.
    it('denies entry with no step-up grant, with no state change', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(deviceRow() as never);
      const res = await post(enterBody({ stepUpGrant: undefined }));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
      expect(db.transaction).not.toHaveBeenCalled();
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
    });

    it('denies entry with a stale or mismatched grant, indistinguishably from a missing one', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(deviceRow() as never);
      vi.mocked(validateStepUpGrant).mockResolvedValueOnce(false);
      const res = await post(enterBody());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
      expect(db.transaction).not.toHaveBeenCalled();
    });

    // ---- T4: happy path (this REPLACES "enables maintenance mode for eligible
    // devices" and asserts strictly more: the grant binding and the audit).
    it('enters maintenance with a valid grant, consuming it with the exact binding, and audits actor/reason/window', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(deviceRow() as never);
      const { captured, calls } = mockMaintenanceTx(deviceRow());
      const res = await post(enterBody());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ success: true, action: 'enable' });
      expect(body.maintenance).toMatchObject({ reason: 'scheduled patching' });
      expect(calls).toEqual(['select-for-update', 'update']);
      expect(captured[0]).toMatchObject({ status: 'maintenance', maintenanceReason: 'scheduled patching', maintenanceStartedBy: 'user-123' });
      expect(consumeStepUpGrant).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', {
        userId: 'user-123',
        operation: 'device_maintenance',
        authEpoch: 1,
        mfaEpoch: 1,
        sid: 'sid-1',
        resourceDigest: maintenanceResourceDigest({ deviceIds: ['device-a'], reason: 'scheduled patching', durationHours: 2 }),
      });
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'device.maintenance.enable',
        details: expect.objectContaining({ reason: 'scheduled patching', durationHours: 2, stepUp: 'grant' }),
      }));
    });

    // ---- T5: extension semantics.
    it('extends an ACTIVE lease from now (never compounding), keeping the original actor, and audits device.maintenance.extend', async () => {
      const originalStart = new Date(Date.now() - 3_600_000);
      const row = deviceRow({
        status: 'maintenance', maintenanceUntil: new Date(Date.now() + 3_600_000),
        maintenanceStartedAt: originalStart, maintenanceReason: 'old reason', maintenanceStartedBy: 'user-original',
      });
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(row as never);
      const { captured } = mockMaintenanceTx(row);
      const res = await post(enterBody({ reason: 'still patching' }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.action).toBe('extend');
      // now + 2h, not (now + 1h) + 2h
      expect(new Date(body.maintenance.until).getTime() - Date.now()).toBeGreaterThan(1.9 * 3_600_000);
      expect(new Date(body.maintenance.until).getTime() - Date.now()).toBeLessThan(2.1 * 3_600_000);
      expect(captured[0]).not.toHaveProperty('maintenanceStartedBy');
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'device.maintenance.extend',
        details: expect.objectContaining({ previousReason: 'old reason' }),
      }));
    });

    it('treats an EXPIRED lease as a fresh entry and still requires the grant', async () => {
      authState.mfa = false;
      const row = deviceRow({ status: 'maintenance', maintenanceUntil: new Date(Date.now() - 3_600_000), maintenanceStartedAt: new Date(Date.now() - 7_200_000), maintenanceReason: 'old', maintenanceStartedBy: 'user-original' });
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(row as never);
      const res = await post(enterBody());
      expect(res.status).toBe(403);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it.each(['quarantined', 'pending', 'updating'])(
      'refuses entry for a %s device with 409 MAINTENANCE_STATE_CONFLICT and no state change', async (status) => {
        vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(deviceRow({ status }) as never);
        const res = await post(enterBody());
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: 'MAINTENANCE_STATE_CONFLICT' });
        expect(db.transaction).not.toHaveBeenCalled();
      });

    // ---- REPLACES "rejects maintenance mode changes for decommissioned devices"
    it('rejects maintenance mode changes for decommissioned devices, with no state change', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(deviceRow({ status: 'decommissioned' }) as never);
      const res = await post(enterBody());
      expect(res.status).toBe(400);
      expect(db.transaction).not.toHaveBeenCalled();
      // A request denied on AUTHORIZATION grounds must not burn the grant:
      // validate/consume sit after the device checks precisely so a technician
      // does not have to re-step-up because they aimed at the wrong device.
      expect(validateStepUpGrant).not.toHaveBeenCalled();
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
    });

    // ---- REPLACES "denies maintenance changes when site scope excludes the device"
    it('denies maintenance changes when site scope excludes the device, with no state change', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(deviceRow({ siteId: 'site-denied' }) as never);
      const res = await post(enterBody(), { 'x-site-restricted': 'true' });
      expect(res.status).toBe(403);
      expect(db.transaction).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(validateStepUpGrant).not.toHaveBeenCalled();
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
    });

    // ---- T6: consume race.
    it('returns 403 STEP_UP_REQUIRED and issues no UPDATE when the grant is consumed by a racing request', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(deviceRow() as never);
      vi.mocked(consumeStepUpGrant).mockResolvedValueOnce(false);
      const { calls } = mockMaintenanceTx(deviceRow());
      const res = await post(enterBody());
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
      expect(calls).not.toContain('update');
    });

    // ---- T7: exit stays un-gated and truthful.
    it('exits maintenance without MFA or a grant and resolves status from FRESH liveness (offline)', async () => {
      authState.mfa = false;
      const row = deviceRow({ status: 'maintenance', lastSeenAt: new Date(Date.now() - 10 * 60_000), maintenanceUntil: new Date(Date.now() + 3_600_000), maintenanceStartedAt: new Date(Date.now() - 3_600_000), maintenanceReason: 'r', maintenanceStartedBy: 'user-123' });
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(row as never);
      const { captured } = mockMaintenanceTx(row);
      const res = await post(JSON.stringify({ enable: false }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true, changed: true });
      expect(captured[0]).toMatchObject({ status: 'offline', maintenanceUntil: null });
      expect(validateStepUpGrant).not.toHaveBeenCalled();
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'device.maintenance.disable',
        details: expect.objectContaining({ resolvedStatus: 'offline', endedEarly: true }),
      }));
    });

    it('resolves a recently-seen device to online on exit', async () => {
      const row = deviceRow({ status: 'maintenance', lastSeenAt: new Date(Date.now() - 60_000), maintenanceUntil: new Date(Date.now() + 3_600_000), maintenanceStartedAt: new Date(Date.now() - 3_600_000), maintenanceReason: 'r', maintenanceStartedBy: 'user-123' });
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(row as never);
      const { captured } = mockMaintenanceTx(row);
      await post(JSON.stringify({ enable: false }));
      expect(captured[0]).toMatchObject({ status: 'online' });
    });

    it('is a 200 no-op with changed:false and NO audit row when there is nothing to end', async () => {
      const row = deviceRow({ status: 'online' });
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(row as never);
      const { calls } = mockMaintenanceTx(row);
      const res = await post(JSON.stringify({ enable: false }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ changed: false });
      expect(calls).not.toContain('update');
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    // ---- T8: body contract.
    it.each([
      ['missing reason', { enable: true, durationHours: 2 }],
      ['reason under 3 chars', { enable: true, reason: 'ab', durationHours: 2 }],
      ['durationHours 0', { enable: true, reason: 'scheduled patching', durationHours: 0 }],
      ['durationHours 169', { enable: true, reason: 'scheduled patching', durationHours: 169 }],
      ['unknown field on entry', { enable: true, reason: 'scheduled patching', durationHours: 2, sneaky: 1 }],
      ['durationHours on exit (strict)', { enable: false, durationHours: 2 }],
    ])('rejects %s with 400 and no state change', async (_label, body) => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(deviceRow() as never);
      const res = await post(JSON.stringify(body));
      expect(res.status).toBe(400);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    // ---- T9: machine-principal denial that does NOT depend on the MFA gate.
    it.each([[true], [false]])(
      'denies an api_key principal on ENTRY with ENABLE_2FA=%s, with no state change', async (twoFactorOn) => {
        // With ENABLE_2FA=false, hasSatisfiedMfa returns true for ANY context and
        // API-key contexts carry token:{} (routes/mcpServer.ts:2246) — so if the
        // interactive gate were removed, this case would 200. That is exactly why
        // it runs with 2FA OFF as well as on.
        enable2faState.value = twoFactorOn;
        authState.principalKind = 'api_key';
        // Faithful to the PRODUCTION shape: API-key/MCP-OAuth contexts are
        // built with `token: {}` (routes/mcpServer.ts:2246), i.e. no `mfa`
        // claim at all. That is what makes the ENABLE_2FA=false variant the
        // load-bearing one: hasSatisfiedMfa short-circuits to TRUE when 2FA is
        // off, so requireMfa() would ADMIT this caller and only the
        // interactive gate denies it.
        authState.mfa = false;
        authState.sid = undefined;
        vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(deviceRow() as never);
        const res = await post(enterBody());
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Interactive user session required' });
        expect(db.transaction).not.toHaveBeenCalled();
        expect(db.update).not.toHaveBeenCalled();
        expect(getDeviceWithOrgCheck).not.toHaveBeenCalled();
      });

    it.each([[true], [false]])(
      'denies an api_key principal on EXIT with ENABLE_2FA=%s, with no state change', async (twoFactorOn) => {
        enable2faState.value = twoFactorOn;
        authState.principalKind = 'api_key';
        authState.mfa = false;
        authState.sid = undefined;
        const res = await post(JSON.stringify({ enable: false }));
        expect(res.status).toBe(403);
        expect(db.transaction).not.toHaveBeenCalled();
      });

    it('denies an oauth_grant principal — acting FOR a user is not acting AS an interactive session', async () => {
      authState.principalKind = 'oauth_grant';
      authState.mfa = false;
      authState.sid = undefined;
      const res = await post(enterBody());
      expect(res.status).toBe(403);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('skips the grant requirement when ENABLE_2FA is off, and records stepUp: disabled_2fa', async () => {
      enable2faState.value = false;
      authState.mfa = false;
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(deviceRow() as never);
      mockMaintenanceTx(deviceRow());
      const res = await post(JSON.stringify({ enable: true, reason: 'scheduled patching', durationHours: 2 }));
      expect(res.status).toBe(200);
      expect(validateStepUpGrant).not.toHaveBeenCalled();
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        details: expect.objectContaining({ stepUp: 'disabled_2fa' }),
      }));
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

    it('passes through raw stdout for capture_pprof so profiles are retrievable (#2401)', async () => {
      const pprofStdout = JSON.stringify({
        capturedAt: '2026-07-12T10:00:00Z',
        heapProfileBase64: 'aGVhcC1wcm9maWxlLWJ5dGVz',
        heapProfileBytes: 2048,
      });

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
              id: 'cmd-pprof',
              deviceId: 'device-a',
              type: 'capture_pprof',
              status: 'completed',
              payload: { profile: 'heap' },
              result: { status: 'completed', stdout: pprofStdout }
            }])
          })
        })
      } as never);

      const res = await app.request('/devices/device-a/commands/cmd-pprof', {
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.result.stdout).toBe(pprofStdout);
    });
  });

  describe('GET /devices/:id/commands', () => {
    it('keeps capture_pprof stdout redacted in the LIST endpoint (no raw pass-through)', async () => {
      // The raw stdout pass-through is deliberately scoped to the
      // single-command GET; history pages must never balloon by megabytes of
      // base64 per capture_pprof row (#2401).
      const pprofStdout = JSON.stringify({
        heapProfileBase64: 'aGVhcC1wcm9maWxlLWJ5dGVz',
        heapProfileBytes: 2048,
      });

      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce({
        id: 'device-a',
        orgId: 'org-123',
        hostname: 'host-a',
        status: 'online'
      } as never);

      vi.mocked(db.select)
        // count query
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as never)
        // page query
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([{
                    id: 'cmd-pprof',
                    deviceId: 'device-a',
                    type: 'capture_pprof',
                    status: 'completed',
                    payload: { profile: 'heap' },
                    result: { status: 'completed', stdout: pprofStdout }
                  }])
                })
              })
            })
          })
        } as never);

      const res = await app.request('/devices/device-a/commands', {
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data[0].result.stdout).toContain('stdout omitted');
      expect(JSON.stringify(body)).not.toContain('aGVhcC1wcm9maWxlLWJ5dGVz');
    });

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

    it('denies auto-update commands when site scope excludes the device', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce({
        id: 'device-a',
        orgId: 'org-123',
        siteId: 'site-denied',
        status: 'online'
      } as never);

      const res = await app.request('/devices/device-a/auto-update', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
          'x-site-restricted': 'true',
        },
        body: JSON.stringify({ enabled: true })
      });

      expect(res.status).toBe(403);
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  });
});
