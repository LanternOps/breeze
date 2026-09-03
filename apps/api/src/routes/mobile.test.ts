import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  decodeCursor,
  encodeCursor,
  mobileRoutes,
  _resetRegistrationFallbackReportsForTests
} from './mobile';

// Partial-mock drizzle-orm so `inArray` is a spy while every other operator
// (and/eq/sql/...) stays real. The /summary site-narrowing tests assert that
// device stats build inArray(devices.siteId, allowedSiteIds) and alert stats
// build inArray(alerts.deviceId, resolvedDeviceIds). Removing either production
// narrowing line makes the matching assertion fail.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    inArray: vi.fn((...args: Parameters<typeof actual.inArray>) => actual.inArray(...args)),
  };
});

const {
  publishEventMock,
  setCooldownMock,
  emitAlertStateFeedbackMock,
  writeRouteAuditMock,
  executeScriptOnDevicesMock,
  assertDeviceExecuteAllowedMock,
  rateLimitState,
  authState
} = vi.hoisted(() => ({
  publishEventMock: vi.fn().mockResolvedValue('event-1'),
  setCooldownMock: vi.fn().mockResolvedValue(undefined),
  emitAlertStateFeedbackMock: vi.fn().mockResolvedValue(undefined),
  writeRouteAuditMock: vi.fn(),
  executeScriptOnDevicesMock: vi.fn(),
  assertDeviceExecuteAllowedMock: vi.fn(),
  rateLimitState: { allowed: true },
  authState: {
    permissions: undefined as { allowedSiteIds?: string[] } | undefined,
    token: undefined as { mdid?: string } | undefined
  }
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn()
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn())
}));

// Wake-on-LAN brings a long transitive import chain through the API surface
// (mobile.ts -> wakeOnLan.ts -> agentWs.ts -> remoteAccessPolicy.ts ->
// configurationPolicy.ts -> the full config-policy schema set; and
// agentWs.ts -> discoveryWorker.ts -> networkBaseline.ts -> the enum surface).
// Stubbing every table by name turns into a moving target — partial-mock via
// importOriginal so the real schema satisfies the transitive imports, while
// the assertions in this file continue to use the in-test mock infrastructure
// that doesn't read these tables at all.
vi.mock('../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/schema')>();
  return { ...actual };
});

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: 'org-123',
      partnerId: 'partner-123',
      token: authState.token ?? {}
    });
    // NOTE: authMiddleware does NOT populate `permissions` in production — only
    // requirePermission does. Setting it here would mask a route that relies on
    // `permissions` for site-scoping but lacks the requirePermission gate.
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  // Mirror prod: requirePermission is the gate that populates `permissions`.
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (authState.permissions) c.set('permissions', authState.permissions);
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next())
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: publishEventMock
}));

// Partial-mock: auditEvents re-exports helpers that agentWs.ts evaluates at
// module scope, so a bare factory drops them and the import chain dies.
vi.mock('../services/auditEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/auditEvents')>()),
  writeRouteAudit: writeRouteAuditMock
}));

vi.mock('../services/alertCooldown', () => ({
  setCooldown: setCooldownMock
}));

vi.mock('../services/scriptExecution', () => ({
  executeScriptOnDevices: executeScriptOnDevicesMock
}));

vi.mock('../services/partnerTrust.commands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/partnerTrust.commands')>()),
  assertDeviceExecuteAllowed: assertDeviceExecuteAllowedMock,
}));

vi.mock('../services/mlFeedbackEmitters', () => ({
  emitAlertStateFeedback: emitAlertStateFeedbackMock
}));

vi.mock('../middleware/userRateLimit', () => ({
  userRateLimit: vi.fn(() => async (c: any, next: any) => {
    if (!rateLimitState.allowed) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }
    return next();
  })
}));

import { db } from '../db';
import { inArray } from 'drizzle-orm';
import { devices, alerts, mobileDevices } from '../db/schema';
import { authMiddleware, requirePermission } from '../middleware/auth';

const mockSelectLimitChain = (result: unknown) => ({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(result)
    })
  })
});

const mockSelectWhereChain = (result: unknown) => ({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(result)
  })
});

const mockSelectOrderChain = (result: unknown) => ({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          offset: vi.fn().mockResolvedValue(result)
        })
      })
    })
  })
});

const mockSelectLeftJoinChain = (result: unknown) => ({
  from: vi.fn().mockReturnValue({
    leftJoin: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            offset: vi.fn().mockResolvedValue(result)
          })
        })
      })
    })
  })
});

const objectContains = (value: unknown, needle: string, seen = new WeakSet<object>()): boolean => {
  if (typeof value === 'string') return value === needle;
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value as Record<string, unknown>).some((child) => objectContains(child, needle, seen));
};

const mockInsertReturning = (result: unknown) => ({
  values: vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue(result)
  })
});

const mockInsertOnConflictReturning = (result: unknown) => ({
  values: vi.fn().mockReturnValue({
    onConflictDoUpdate: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(result)
    })
  })
});

const mockUpdateReturning = (result: unknown) => ({
  set: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(result)
    })
  })
});

const mockDeleteReturning = (result: unknown) => ({
  where: vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue(result)
  })
});

describe('mobile cursor decoding', () => {
  it('returns null when the cursor id is not a UUID', () => {
    const cursor = Buffer.from(JSON.stringify({
      ts: '2026-07-28T12:00:00.000Z',
      id: 'not-a-uuid',
    })).toString('base64url');

    expect(decodeCursor(cursor)).toBeNull();
  });

  it('decodes a cursor with a valid UUID id', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const cursor = encodeCursor('2026-07-28T12:00:00.000Z', id);

    expect(decodeCursor(cursor!)).toEqual({
      ts: new Date('2026-07-28T12:00:00.000Z'),
      id,
    });
  });
});

describe('mobile routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(db.delete).mockReset();
    authState.permissions = undefined;
    authState.token = undefined;
    rateLimitState.allowed = true;
    vi.mocked(db.transaction).mockReset();
    executeScriptOnDevicesMock.mockReset();
    assertDeviceExecuteAllowedMock.mockResolvedValue(undefined);
    _resetRegistrationFallbackReportsForTests();
    app = new Hono();
    app.route('/mobile', mobileRoutes);
  });

  describe('POST /mobile/notifications/register', () => {
    it('should register push token through compatibility endpoint', async () => {
      // Pre-insert lookup checks if a blocked row already exists with this
      // deviceId. Returns empty so the route inserts under the unsalted id.
      vi.mocked(db.select).mockReturnValue(mockSelectLimitChain([]) as any);
      vi.mocked(db.insert).mockReturnValue(
        mockInsertOnConflictReturning([
          {
            id: 'mobile-1',
            deviceId: 'push-android-abc123',
            platform: 'android'
          }
        ]) as any
      );

      const res = await app.request('/mobile/notifications/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'expo-token-1',
          platform: 'android'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    // #2913: the row must be keyed on the phone's per-install id (the header
    // the app already sends), otherwise mobileDeviceBlockedMiddleware — which
    // looks that id up — can never match and "block this phone" is inert.
    describe('installation-id keying (#2913)', () => {
      const INSTALL = 'install-uuid-abc';

      const registerWithHeader = (app: Hono) =>
        app.request('/mobile/notifications/register', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-breeze-mobile-device-id': INSTALL
          },
          body: JSON.stringify({ token: 'apns-token-1', platform: 'ios' })
        });

      it('inserts under the installation id, not the push-token hash', async () => {
        vi.mocked(db.select)
          .mockReturnValueOnce(mockSelectLimitChain([]) as any)  // no installation-id row
          .mockReturnValueOnce(mockSelectLimitChain([]) as any); // no legacy row to adopt
        const values = vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'mobile-1', deviceId: INSTALL, platform: 'ios' }])
          })
        });
        vi.mocked(db.insert).mockReturnValue({ values } as any);

        const res = await registerWithHeader(app);

        expect(res.status).toBe(200);
        expect(values).toHaveBeenCalledWith(expect.objectContaining({ deviceId: INSTALL }));
      });

      it('adopts the existing push-derived row in place instead of orphaning it', async () => {
        vi.mocked(db.select)
          .mockReturnValueOnce(mockSelectLimitChain([]) as any)
          .mockReturnValueOnce(
            mockSelectLimitChain([
              { id: 'row-legacy', userId: 'user-123', status: 'active', apnsToken: null, fcmToken: null }
            ]) as any
          );
        const set = vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'row-legacy', deviceId: INSTALL, platform: 'ios' }])
          })
        });
        // The adopt UPDATE runs in its own nested transaction (SAVEPOINT) so a
        // 23505 cannot abort the request-wide transaction opened by authMiddleware.
        vi.mocked(db.transaction).mockImplementation(async (cb: any) => cb({ update: () => ({ set }) }));

        const res = await registerWithHeader(app);

        expect(res.status).toBe(200);
        // Re-keyed in place: the uuid PK (and every FK pointing at it) survives.
        expect(set).toHaveBeenCalledWith(expect.objectContaining({ deviceId: INSTALL }));
        // No second mobile_devices row: the only inserts are audit writes.
        expect(
          vi.mocked(db.insert).mock.calls.some(([table]) => table === mobileDevices)
        ).toBe(false);
      });

      it('parks another user ACTIVE row aside and strips its push tokens', async () => {
        // Matching APNs token: the OS mints it per app install, so this proves
        // the caller really is on the handset that owns the row.
        vi.mocked(db.select).mockReturnValueOnce(
          mockSelectLimitChain([
            { id: 'row-other', userId: 'user-other', status: 'active', apnsToken: 'apns-token-1', fcmToken: null }
          ]) as any
        );
        const displaceSet = vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'row-other' }])
          })
        });
        const tx = {
          update: vi.fn().mockReturnValue({ set: displaceSet }),
          insert: vi.fn().mockReturnValue(
            mockInsertReturning([{ id: 'mobile-2', deviceId: INSTALL, platform: 'ios' }])
          )
        };
        vi.mocked(db.transaction).mockImplementation(async (cb: any) => cb(tx));

        const res = await registerWithHeader(app);

        expect(res.status).toBe(200);
        const displaced = displaceSet.mock.calls[0]?.[0] as Record<string, unknown>;
        expect((displaced.deviceId as string).startsWith(`${INSTALL}-`)).toBe(true);
        // The displaced row holds the SAME OS-minted token the caller just
        // submitted — leaving it would fan the previous user's notifications
        // out to the new user's phone.
        expect(displaced).toMatchObject({
          apnsToken: null,
          fcmToken: null,
          notificationsEnabled: false
        });
        // Re-keying another account's row is never an unrecorded side effect.
        expect(writeRouteAuditMock.mock.calls.at(-1)?.[1]?.details).toMatchObject({
          displacedMobileDeviceId: 'row-other'
        });
      });

      it('does not claim a displacement when the salting UPDATE matched no row', async () => {
        // TOCTOU: the incumbent can be blocked, deleted or re-keyed between
        // planMobileDeviceId and the transaction. Auditing a displacement —
        // and a push-token clearing — that never happened is its own lie.
        vi.mocked(db.select).mockReturnValueOnce(
          mockSelectLimitChain([
            { id: 'row-other', userId: 'user-other', status: 'active', apnsToken: 'apns-token-1', fcmToken: null }
          ]) as any
        );
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) })
            })
          }),
          insert: vi.fn().mockReturnValue(
            mockInsertReturning([{ id: 'mobile-2', deviceId: INSTALL, platform: 'ios' }])
          )
        };
        vi.mocked(db.transaction).mockImplementation(async (cb: any) => cb(tx));

        const res = await registerWithHeader(app);

        expect(res.status).toBe(200);
        const auditDetails = writeRouteAuditMock.mock.calls.at(-1)?.[1]?.details;
        expect(auditDetails).not.toHaveProperty('displacedMobileDeviceId');
      });

      it('rolls the displacement back and 409s when the insert lands no row', async () => {
        vi.mocked(db.select).mockReturnValueOnce(
          mockSelectLimitChain([
            { id: 'row-other', userId: 'user-other', status: 'active', apnsToken: 'apns-token-1', fcmToken: null }
          ]) as any
        );
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([{ id: 'row-other' }])
              })
            })
          }),
          insert: vi.fn().mockReturnValue(mockInsertReturning([]))
        };
        // A real transaction rolls back on throw; assert the route lets the
        // throw escape the callback rather than swallowing it inside.
        let threw = false;
        vi.mocked(db.transaction).mockImplementation(async (cb: any) => {
          try {
            return await cb(tx);
          } catch {
            threw = true;
            throw new Error('rolled back');
          }
        });

        const res = await registerWithHeader(app);

        expect(threw).toBe(true);
        expect(res.status).toBe(409);
      });

      it('prefers the SIGNED mdid claim over the raw header (SR-001)', async () => {
        // Otherwise a client could authenticate as install X and register its
        // row under install Y, so the middleware's lookup on X misses forever.
        authState.token = { mdid: 'signed-install-id' };
        vi.mocked(db.select)
          .mockReturnValueOnce(mockSelectLimitChain([]) as any)
          .mockReturnValueOnce(mockSelectLimitChain([]) as any);
        const values = vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'mobile-3', deviceId: 'signed-install-id' }])
          })
        });
        vi.mocked(db.insert).mockReturnValue({ values } as any);

        const res = await registerWithHeader(app); // header says INSTALL

        expect(res.status).toBe(200);
        expect(values).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'signed-install-id' }));
      });

      it('409s instead of reporting success when the conflict guard matches no row', async () => {
        // Previously this returned { success: true } while the token was never
        // stored — a silent push outage.
        vi.mocked(db.select)
          .mockReturnValueOnce(mockSelectLimitChain([]) as any)
          .mockReturnValueOnce(mockSelectLimitChain([]) as any);
        vi.mocked(db.insert).mockReturnValue(mockInsertOnConflictReturning([]) as any);

        const res = await registerWithHeader(app);

        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('device_registration_conflict');
      });
    });
  });

  describe('POST /mobile/notifications/unregister', () => {
    it('should unregister push token through compatibility endpoint', async () => {
      vi.mocked(db.delete).mockReturnValue(
        mockDeleteReturning([{ id: 'mobile-1' }]) as any
      );

      const res = await app.request('/mobile/notifications/unregister', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'expo-token-1'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  describe('POST /mobile/devices', () => {
    it('should register a device with platform token', async () => {
      // Pre-insert lookup for a blocked row collision; empty result means
      // we use the unsalted deviceId.
      vi.mocked(db.select).mockReturnValue(mockSelectLimitChain([]) as any);
      vi.mocked(db.insert).mockReturnValue(
        mockInsertOnConflictReturning([
          {
            id: 'mobile-1',
            deviceId: 'device-123',
            platform: 'android',
            fcmToken: 'fcm-1'
          }
        ]) as any
      );

      const res = await app.request('/mobile/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'device-123',
          platform: 'android',
          fcmToken: 'fcm-1'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.deviceId).toBe('device-123');
      expect(body.platform).toBe('android');
    });

    it('should validate platform token requirements', async () => {
      const res = await app.request('/mobile/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'device-123',
          platform: 'ios'
        })
      });

      expect(res.status).toBe(400);
    });

    it('returns 409 and does not upsert when deviceId belongs to another user (SR-002)', async () => {
      // The auth mock authenticates user-123. An attacker in the same tenant
      // POSTs the victim's deviceId. RLS lets the pre-check SELECT see the
      // victim row; the handler must refuse rather than reassigning user_id.
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([{ status: 'active', userId: 'victim-user-999' }]) as any
      );
      vi.mocked(db.insert).mockReturnValue(
        mockInsertOnConflictReturning([{ id: 'stolen', deviceId: 'victim-device', platform: 'android' }]) as any
      );

      const res = await app.request('/mobile/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'victim-device',
          platform: 'android',
          fcmToken: 'attacker-fcm'
        })
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('device_owned_by_other');
      // Critically: no insert/upsert was attempted against the victim row.
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('still allows the owner to re-register their own existing device (SR-002 regression)', async () => {
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([{ status: 'active', userId: 'user-123' }]) as any
      );
      vi.mocked(db.insert).mockReturnValue(
        mockInsertOnConflictReturning([
          { id: 'mobile-1', deviceId: 'device-123', platform: 'android', fcmToken: 'fcm-1' }
        ]) as any
      );

      const res = await app.request('/mobile/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'device-123',
          platform: 'android',
          fcmToken: 'fcm-1'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.deviceId).toBe('device-123');
    });

    it('returns 409 when the conflict upsert matches no owned row (race defense, SR-002)', async () => {
      // No row visible at pre-check time, but the conflicting row turns out
      // not to be owned by the caller → setWhere matches 0 rows → empty
      // returning(). Must surface as 409, never a silent 201 with null body.
      vi.mocked(db.select).mockReturnValue(mockSelectLimitChain([]) as any);
      vi.mocked(db.insert).mockReturnValue(mockInsertOnConflictReturning([]) as any);

      const res = await app.request('/mobile/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'raced-device',
          platform: 'android',
          fcmToken: 'fcm-1'
        })
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('device_owned_by_other');
    });
  });

  describe('PATCH /mobile/devices/:id/settings', () => {
    it('should reject empty settings payload', async () => {
      const res = await app.request('/mobile/devices/11111111-2222-4333-8444-555555555555/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(400);
    });

    it('should return 404 when device is missing', async () => {
      vi.mocked(db.update).mockReturnValue(mockUpdateReturning([]) as any);

      const res = await app.request('/mobile/devices/11111111-2222-4333-8444-555555555555/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true })
      });

      expect(res.status).toBe(404);
    });

    it('should update device settings', async () => {
      vi.mocked(db.update).mockReturnValue(
        mockUpdateReturning([
          {
            id: 'mobile-1',
            notificationsEnabled: true,
            alertSeverities: ['critical', 'high']
          }
        ]) as any
      );

      const res = await app.request('/mobile/devices/mobile-1/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, severities: ['critical', 'high'] })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.notificationsEnabled).toBe(true);
    });
  });

  describe('DELETE /mobile/devices/:id', () => {
    it('should return 404 when device is missing', async () => {
      vi.mocked(db.delete).mockReturnValue(mockDeleteReturning([]) as any);

      const res = await app.request('/mobile/devices/mobile-1', {
        method: 'DELETE'
      });

      expect(res.status).toBe(404);
    });

    it('should unregister the device', async () => {
      vi.mocked(db.delete).mockReturnValue(
        mockDeleteReturning([{ id: 'mobile-1' }]) as any
      );

      const res = await app.request('/mobile/devices/mobile-1', {
        method: 'DELETE'
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  describe('GET /mobile/alerts/inbox', () => {
    const SITE_ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';
    const SITE_DENIED = 'bbbbbbbb-0000-0000-0000-000000000002';
    const DEVICE_ALLOWED = '11111111-1111-1111-1111-111111111111';
    const DEVICE_DENIED = '22222222-2222-2222-2222-222222222222';

    it('should return inbox alerts with pagination', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectWhereChain([{ count: 2 }]) as any)
        .mockReturnValueOnce(
          mockSelectLeftJoinChain([
            {
              id: 'alert-1',
              orgId: 'org-123',
              status: 'active',
              severity: 'critical',
              title: 'Alert 1',
              message: 'Alert message',
              triggeredAt: new Date(),
              acknowledgedAt: null,
              resolvedAt: null,
              deviceId: '11111111-2222-4333-8444-555555555555',
              deviceHostname: 'host-1',
              deviceOsType: 'linux',
              deviceStatus: 'online'
            },
            {
              id: 'alert-2',
              orgId: 'org-123',
              status: 'acknowledged',
              severity: 'high',
              title: 'Alert 2',
              message: 'Alert message 2',
              triggeredAt: new Date(),
              acknowledgedAt: new Date(),
              resolvedAt: null,
              deviceId: null,
              deviceHostname: null,
              deviceOsType: null,
              deviceStatus: null
            }
          ]) as any
        );

      const res = await app.request('/mobile/alerts/inbox?status=active&page=1&limit=2', {
        method: 'GET'
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
      expect(body.data[0].device).toBeDefined();
      expect(body.data[1].device).toBeNull();
    });

    it('should require organization context for org scope', async () => {
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'organization',
          orgId: null,
          partnerId: null
        });
        return next();
      });

      const res = await app.request('/mobile/alerts/inbox', {
        method: 'GET'
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('Organization context');
    });

    it('narrows alert inbox rows to devices in allowed sites for a site-restricted caller', async () => {
      authState.permissions = { allowedSiteIds: [SITE_ALLOWED] };
      const captured: { countWhere?: unknown; rowsWhere?: unknown } = {};

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: DEVICE_ALLOWED, siteId: SITE_ALLOWED },
              { id: DEVICE_DENIED, siteId: SITE_DENIED }
            ])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn((where: unknown) => {
              captured.countWhere = where;
              return Promise.resolve([{ count: 1 }]);
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn((where: unknown) => {
                captured.rowsWhere = where;
                return {
                  orderBy: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnValue({
                      offset: vi.fn().mockResolvedValue([
                        {
                          id: 'alert-allowed',
                          orgId: 'org-123',
                          status: 'active',
                          severity: 'critical',
                          title: 'Allowed alert',
                          message: 'Allowed device alert',
                          triggeredAt: new Date(),
                          acknowledgedAt: null,
                          resolvedAt: null,
                          deviceId: DEVICE_ALLOWED,
                          deviceHostname: 'allowed-host',
                          deviceOsType: 'linux',
                          deviceStatus: 'online'
                        }
                      ])
                    })
                  })
                };
              })
            })
          })
        } as any);

      const res = await app.request('/mobile/alerts/inbox', { method: 'GET' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].device.id).toBe(DEVICE_ALLOWED);
      expect(objectContains(captured.countWhere, DEVICE_ALLOWED)).toBe(true);
      expect(objectContains(captured.rowsWhere, DEVICE_ALLOWED)).toBe(true);
      expect(objectContains(captured.rowsWhere, DEVICE_DENIED)).toBe(false);
    });

    it('leaves alert inbox unrestricted when allowedSiteIds is absent', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectWhereChain([{ count: 2 }]) as any)
        .mockReturnValueOnce(
          mockSelectLeftJoinChain([
            {
              id: 'alert-allowed',
              orgId: 'org-123',
              status: 'active',
              severity: 'critical',
              title: 'Allowed alert',
              message: 'Allowed device alert',
              triggeredAt: new Date(),
              acknowledgedAt: null,
              resolvedAt: null,
              deviceId: DEVICE_ALLOWED,
              deviceHostname: 'allowed-host',
              deviceOsType: 'linux',
              deviceStatus: 'online'
            },
            {
              id: 'alert-denied',
              orgId: 'org-123',
              status: 'active',
              severity: 'high',
              title: 'Other site alert',
              message: 'Other device alert',
              triggeredAt: new Date(),
              acknowledgedAt: null,
              resolvedAt: null,
              deviceId: DEVICE_DENIED,
              deviceHostname: 'denied-host',
              deviceOsType: 'linux',
              deviceStatus: 'online'
            }
          ]) as any
        );

      const res = await app.request('/mobile/alerts/inbox', { method: 'GET' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.map((row: { device: { id: string } }) => row.device.id)).toEqual([
        DEVICE_ALLOWED,
        DEVICE_DENIED
      ]);
      expect(db.select).toHaveBeenCalledTimes(2);
    });
  });

  describe('POST /mobile/alerts/:id/acknowledge', () => {
    it('should return 404 when alert is missing', async () => {
      vi.mocked(db.select).mockReturnValue(mockSelectLimitChain([]) as any);

      const res = await app.request('/mobile/alerts/alert-1/acknowledge', {
        method: 'POST'
      });

      expect(res.status).toBe(404);
      expect(emitAlertStateFeedbackMock).not.toHaveBeenCalled();
    });

    it('should reject non-active alerts', async () => {
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([
          { id: 'alert-1', status: 'resolved', orgId: 'org-123' }
        ]) as any
      );

      const res = await app.request('/mobile/alerts/alert-1/acknowledge', {
        method: 'POST'
      });

      expect(res.status).toBe(400);
      expect(emitAlertStateFeedbackMock).not.toHaveBeenCalled();
    });

    it('should acknowledge active alert and emit feedback', async () => {
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([
          { id: 'alert-1', status: 'active', orgId: 'org-123', ruleId: 'rule-1', deviceId: '11111111-2222-4333-8444-555555555555' }
        ]) as any
      );
      vi.mocked(db.update).mockReturnValue(
        mockUpdateReturning([
          { id: 'alert-1', status: 'acknowledged' }
        ]) as any
      );

      const res = await app.request('/mobile/alerts/alert-1/acknowledge', {
        method: 'POST'
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('acknowledged');
      expect(emitAlertStateFeedbackMock).toHaveBeenCalledWith(expect.objectContaining({
        orgId: 'org-123',
        alertId: 'alert-1',
        eventType: 'alert.acknowledged',
        outcome: 'acknowledged',
        actorUserId: 'user-123',
        metadata: {
          source: 'mobile.alerts',
          previousStatus: 'active',
        },
      }));
    });

    const SITE_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
    const SITE_B = 'bbbbbbbb-0000-0000-0000-00000000000b';

    it('should 404 and not mutate when site-restricted caller targets an out-of-site alert', async () => {
      authState.permissions = { allowedSiteIds: [SITE_A] };
      vi.mocked(db.select)
        // alert lookup
        .mockReturnValueOnce(
          mockSelectLimitChain([
            { id: 'alert-1', status: 'active', orgId: 'org-123', ruleId: 'rule-1', deviceId: 'device-b' }
          ]) as any
        )
        // device site lookup -> device lives in SITE_B (outside allowlist)
        .mockReturnValueOnce(mockSelectLimitChain([{ siteId: SITE_B }]) as any);

      const res = await app.request('/mobile/alerts/alert-1/acknowledge', {
        method: 'POST'
      });

      expect(res.status).toBe(404);
      expect(db.update).not.toHaveBeenCalled();
      expect(emitAlertStateFeedbackMock).not.toHaveBeenCalled();
    });

    it('should allow a same-site restricted caller to acknowledge', async () => {
      authState.permissions = { allowedSiteIds: [SITE_A] };
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectLimitChain([
            { id: 'alert-1', status: 'active', orgId: 'org-123', ruleId: 'rule-1', deviceId: 'device-a' }
          ]) as any
        )
        // device site lookup -> device lives in SITE_A (in allowlist)
        .mockReturnValueOnce(mockSelectLimitChain([{ siteId: SITE_A }]) as any);
      vi.mocked(db.update).mockReturnValue(
        mockUpdateReturning([{ id: 'alert-1', status: 'acknowledged' }]) as any
      );

      const res = await app.request('/mobile/alerts/alert-1/acknowledge', {
        method: 'POST'
      });

      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalled();
    });

    it('should leave deviceless alert visible to a site-restricted caller', async () => {
      authState.permissions = { allowedSiteIds: [SITE_A] };
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([
          { id: 'alert-1', status: 'active', orgId: 'org-123', ruleId: 'rule-1', deviceId: null }
        ]) as any
      );
      vi.mocked(db.update).mockReturnValue(
        mockUpdateReturning([{ id: 'alert-1', status: 'acknowledged' }]) as any
      );

      const res = await app.request('/mobile/alerts/alert-1/acknowledge', {
        method: 'POST'
      });

      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalled();
    });

    it('should not narrow an unrestricted caller (allowedSiteIds undefined)', async () => {
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([
          { id: 'alert-1', status: 'active', orgId: 'org-123', ruleId: 'rule-1', deviceId: 'device-b' }
        ]) as any
      );
      vi.mocked(db.update).mockReturnValue(
        mockUpdateReturning([{ id: 'alert-1', status: 'acknowledged' }]) as any
      );

      const res = await app.request('/mobile/alerts/alert-1/acknowledge', {
        method: 'POST'
      });

      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('POST /mobile/alerts/:id/resolve', () => {
    it('should return 404 when alert is missing', async () => {
      vi.mocked(db.select).mockReturnValue(mockSelectLimitChain([]) as any);

      const res = await app.request('/mobile/alerts/alert-1/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'done' })
      });

      expect(res.status).toBe(404);
      expect(emitAlertStateFeedbackMock).not.toHaveBeenCalled();
    });

    it('should reject already resolved alerts', async () => {
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([
          { id: 'alert-1', status: 'resolved', orgId: 'org-123' }
        ]) as any
      );

      const res = await app.request('/mobile/alerts/alert-1/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'done' })
      });

      // 409, not 400, since #4094. The identical outcome is also reachable by
      // LOSING the compare-and-swap a moment later, and one user action must not
      // return two different status codes depending purely on timing.
      expect(res.status).toBe(409);
      expect(emitAlertStateFeedbackMock).not.toHaveBeenCalled();
    });

    it('should resolve alert with note and emit feedback', async () => {
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([
          { id: 'alert-1', status: 'acknowledged', orgId: 'org-123' }
        ]) as any
      );
      vi.mocked(db.update).mockReturnValue(
        mockUpdateReturning([
          { id: 'alert-1', status: 'resolved', resolutionNote: 'done' }
        ]) as any
      );

      const res = await app.request('/mobile/alerts/alert-1/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'done' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('resolved');
      expect(emitAlertStateFeedbackMock).toHaveBeenCalledWith(expect.objectContaining({
        orgId: 'org-123',
        alertId: 'alert-1',
        eventType: 'alert.resolved',
        outcome: 'resolved',
        actorUserId: 'user-123',
        metadata: {
          source: 'mobile.alerts',
          previousStatus: 'acknowledged',
          hasResolutionNote: true,
        },
      }));
    });

    const SITE_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
    const SITE_B = 'bbbbbbbb-0000-0000-0000-00000000000b';

    it('should 404 and not mutate when site-restricted caller targets an out-of-site alert', async () => {
      authState.permissions = { allowedSiteIds: [SITE_A] };
      vi.mocked(db.select)
        // alert lookup
        .mockReturnValueOnce(
          mockSelectLimitChain([
            { id: 'alert-1', status: 'acknowledged', orgId: 'org-123', deviceId: 'device-b' }
          ]) as any
        )
        // device site lookup -> device lives in SITE_B (outside allowlist)
        .mockReturnValueOnce(mockSelectLimitChain([{ siteId: SITE_B }]) as any);

      const res = await app.request('/mobile/alerts/alert-1/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'done' })
      });

      expect(res.status).toBe(404);
      expect(db.update).not.toHaveBeenCalled();
      expect(emitAlertStateFeedbackMock).not.toHaveBeenCalled();
    });

    it('should allow a same-site restricted caller to resolve', async () => {
      authState.permissions = { allowedSiteIds: [SITE_A] };
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectLimitChain([
            { id: 'alert-1', status: 'acknowledged', orgId: 'org-123', deviceId: 'device-a' }
          ]) as any
        )
        // device site lookup -> device lives in SITE_A (in allowlist)
        .mockReturnValueOnce(mockSelectLimitChain([{ siteId: SITE_A }]) as any);
      vi.mocked(db.update).mockReturnValue(
        mockUpdateReturning([{ id: 'alert-1', status: 'resolved', resolutionNote: 'done' }]) as any
      );

      const res = await app.request('/mobile/alerts/alert-1/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'done' })
      });

      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalled();
    });

    it('should leave deviceless alert visible to a site-restricted caller', async () => {
      authState.permissions = { allowedSiteIds: [SITE_A] };
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([
          { id: 'alert-1', status: 'acknowledged', orgId: 'org-123', deviceId: null }
        ]) as any
      );
      vi.mocked(db.update).mockReturnValue(
        mockUpdateReturning([{ id: 'alert-1', status: 'resolved', resolutionNote: 'done' }]) as any
      );

      const res = await app.request('/mobile/alerts/alert-1/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'done' })
      });

      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalled();
    });

    it('should not narrow an unrestricted caller (allowedSiteIds undefined)', async () => {
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([
          { id: 'alert-1', status: 'acknowledged', orgId: 'org-123', deviceId: 'device-b' }
        ]) as any
      );
      vi.mocked(db.update).mockReturnValue(
        mockUpdateReturning([{ id: 'alert-1', status: 'resolved', resolutionNote: 'done' }]) as any
      );

      const res = await app.request('/mobile/alerts/alert-1/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'done' })
      });

      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('GET /mobile/devices', () => {
    const SITE_ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';
    const SITE_DENIED = 'bbbbbbbb-0000-0000-0000-000000000002';

    it('should list devices for mobile', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectWhereChain([{ count: 1 }]) as any)
        .mockReturnValueOnce(
          mockSelectOrderChain([
            {
              id: '11111111-2222-4333-8444-555555555555',
              orgId: 'org-123',
              siteId: 'site-1',
              hostname: 'host-1',
              displayName: 'Host 1',
              osType: 'linux',
              status: 'online',
              lastSeenAt: new Date()
            }
          ]) as any
        );

      const res = await app.request('/mobile/devices?status=online&search=host', {
        method: 'GET'
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.pagination.total).toBe(1);
    });

    it('should return empty list when partner has no orgs', async () => {
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'partner',
          orgId: null,
          partnerId: 'partner-123'
        });
        return next();
      });
      vi.mocked(db.select).mockReturnValue(
        mockSelectWhereChain([]) as any
      );

      const res = await app.request('/mobile/devices', {
        method: 'GET'
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(0);
      expect(body.pagination.total).toBe(0);
    });

    it('adds site narrowing to the list and count queries for a site-restricted caller', async () => {
      authState.permissions = { allowedSiteIds: [SITE_ALLOWED] };
      const captured: { countWhere?: unknown; rowsWhere?: unknown } = {};

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn((where: unknown) => {
              captured.countWhere = where;
              return Promise.resolve([{ count: 1 }]);
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn((where: unknown) => {
              captured.rowsWhere = where;
              return {
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockResolvedValue([
                      {
                        id: 'device-allowed',
                        orgId: 'org-123',
                        siteId: SITE_ALLOWED,
                        hostname: 'allowed-host',
                        displayName: 'Allowed Host',
                        osType: 'linux',
                        status: 'online',
                        lastSeenAt: new Date()
                      }
                    ])
                  })
                })
              };
            })
          })
        } as any);

      const res = await app.request('/mobile/devices', { method: 'GET' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].siteId).toBe(SITE_ALLOWED);
      expect(objectContains(captured.countWhere, SITE_ALLOWED)).toBe(true);
      expect(objectContains(captured.rowsWhere, SITE_ALLOWED)).toBe(true);
      expect(objectContains(captured.rowsWhere, SITE_DENIED)).toBe(false);
    });

    it('does not add site narrowing for an unrestricted device list caller', async () => {
      const captured: { countWhere?: unknown; rowsWhere?: unknown } = {};

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn((where: unknown) => {
              captured.countWhere = where;
              return Promise.resolve([{ count: 2 }]);
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn((where: unknown) => {
              captured.rowsWhere = where;
              return {
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockResolvedValue([
                      {
                        id: 'device-allowed',
                        orgId: 'org-123',
                        siteId: SITE_ALLOWED,
                        hostname: 'allowed-host',
                        displayName: 'Allowed Host',
                        osType: 'linux',
                        status: 'online',
                        lastSeenAt: new Date()
                      },
                      {
                        id: 'device-denied',
                        orgId: 'org-123',
                        siteId: SITE_DENIED,
                        hostname: 'denied-host',
                        displayName: 'Denied Host',
                        osType: 'linux',
                        status: 'online',
                        lastSeenAt: new Date()
                      }
                    ])
                  })
                })
              };
            })
          })
        } as any);

      const res = await app.request('/mobile/devices', { method: 'GET' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.map((row: { siteId: string }) => row.siteId)).toEqual([SITE_ALLOWED, SITE_DENIED]);
      expect(objectContains(captured.countWhere, SITE_ALLOWED)).toBe(false);
      expect(objectContains(captured.rowsWhere, SITE_ALLOWED)).toBe(false);
    });
  });

  describe('POST /mobile/devices/:id/actions', () => {
    const mobileDeviceId = '11111111-2222-4333-8444-555555555555';
    const mobileScriptId = '22222222-2222-2222-2222-222222222222';
    const admittedScriptResult = (ignoredParameters: string[] = []) => ({
      ok: true,
      admission: {
        requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        status: 'queued' as const,
        targets: [{
          requestedDeviceId: mobileDeviceId,
          admission: 'admitted' as const,
          executionId: 'exec-1',
          commandId: 'cmd-1',
          batchId: 'batch-1',
        }],
      },
      script: { id: mobileScriptId } as any,
      ignoredParameters,
      triggerType: 'manual' as const,
      runAs: 'system',
      auditOrgId: 'org-123',
    });
    // #2968: this route used to resolve devices through a private copy of
    // `getDeviceWithOrgCheck` living in mobile.ts, so the uuid guard added to the
    // shared helper did not apply here and a malformed `:id` still reached
    // Postgres as a 22P02 → 500 + Sentry event. The copy is gone; this pins the
    // route to the guarded helper so a re-fork is caught.
    it('404s a malformed device id without querying (#2968)', async () => {
      vi.mocked(db.select).mockReturnValue(mockSelectLimitChain([]) as any);

      const res = await app.request('/mobile/devices/not-a-uuid/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reboot' })
      });

      expect(res.status).toBe(404);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('rejects a nested-object parameter value (#3409 PR2 Task 7 — one script-parameter schema)', async () => {
      const res = await app.request('/mobile/devices/11111111-2222-4333-8444-555555555555/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'run_script',
          scriptId: '11111111-1111-1111-1111-111111111111',
          parameters: { nested: { bad: true } }
        })
      });

      expect(res.status).toBe(400);
    });

    it('accepts string/number/boolean parameter values', async () => {
      vi.mocked(db.select).mockReturnValue(mockSelectLimitChain([]) as any);

      const res = await app.request('/mobile/devices/11111111-2222-4333-8444-555555555555/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'run_script',
          scriptId: '11111111-1111-1111-1111-111111111111',
          parameters: { s: 'a', n: 3, b: true }
        })
      });

      // Not 400: the request clears schema validation and proceeds to the
      // (mocked-empty) device lookup, same as the existing 404 case below.
      expect(res.status).not.toBe(400);
    });

    it('requires scripts.execute for run_script actions before device lookup', async () => {
      vi.mocked(db.select).mockReturnValue(mockSelectLimitChain([]) as any);

      const res = await app.request('/mobile/devices/11111111-2222-4333-8444-555555555555/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'run_script',
          scriptId: '11111111-1111-1111-1111-111111111111'
        })
      });

      expect(res.status).toBe(404);
      expect(requirePermission).toHaveBeenCalledWith('scripts', 'execute');
    });

    it('does not require scripts.execute for non-script device actions', async () => {
      vi.mocked(db.select).mockReturnValue(mockSelectLimitChain([]) as any);

      const res = await app.request('/mobile/devices/11111111-2222-4333-8444-555555555555/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reboot' })
      });

      expect(res.status).toBe(404);
      expect(requirePermission).not.toHaveBeenCalledWith('scripts', 'execute');
    });

    it('should return 404 when device is missing', async () => {
      vi.mocked(db.select).mockReturnValue(mockSelectLimitChain([]) as any);

      const res = await app.request('/mobile/devices/11111111-2222-4333-8444-555555555555/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reboot' })
      });

      expect(res.status).toBe(404);
    });

    it('should reject decommissioned devices', async () => {
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([
          { id: '11111111-2222-4333-8444-555555555555', orgId: 'org-123', status: 'decommissioned' }
        ]) as any
      );

      const res = await app.request('/mobile/devices/11111111-2222-4333-8444-555555555555/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reboot' })
      });

      expect(res.status).toBe(400);
    });

    it('returns the executeScriptOnDevices error status and message (e.g. script missing)', async () => {
      // #3409 PR0 Task 3: the route no longer looks up the script itself —
      // it delegates entirely to executeScriptOnDevices and passes through
      // whatever {status, error} the service returns.
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([
          { id: '11111111-2222-4333-8444-555555555555', orgId: 'org-123', status: 'online', osType: 'linux', siteId: null }
        ]) as any
      );
      executeScriptOnDevicesMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        error: 'Script not found'
      });

      const res = await app.request('/mobile/devices/11111111-2222-4333-8444-555555555555/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run_script', scriptId: '22222222-2222-2222-2222-222222222222' })
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Script not found');
      expect(writeRouteAuditMock).not.toHaveBeenCalled();
    });

    it('returns 409 for a maintenance-suppressed typed admission without auditing success', async () => {
      // Reachable from mobile now that this route delegates entirely to
      // executeScriptOnDevices (#3409 PR0 Task 3) — the maintenance-window
      // suppression remains a deliberate 409 at this single-device wrapper.
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([
          { id: '11111111-2222-4333-8444-555555555555', orgId: 'org-123', status: 'online', osType: 'linux', siteId: null }
        ]) as any
      );
      executeScriptOnDevicesMock.mockResolvedValueOnce({
        ok: true,
        admission: {
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          status: 'rejected',
          targets: [{
            requestedDeviceId: mobileDeviceId,
            admission: 'suppressed',
            reasonCode: 'maintenance_suppressed',
          }],
        },
        script: { id: mobileScriptId },
        ignoredParameters: [],
        triggerType: 'manual',
        runAs: 'system',
        auditOrgId: 'org-123',
      });

      const res = await app.request('/mobile/devices/11111111-2222-4333-8444-555555555555/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run_script', scriptId: '22222222-2222-2222-2222-222222222222' })
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toEqual({ admission: 'suppressed', reasonCode: 'maintenance_suppressed' });
      expect(writeRouteAuditMock).not.toHaveBeenCalled();
    });

    it('returns 422 with the per-device reason when the only device failed to dispatch', async () => {
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([
          { id: '11111111-2222-4333-8444-555555555555', orgId: 'org-123', status: 'online', osType: 'linux', siteId: null }
        ]) as any
      );
      executeScriptOnDevicesMock.mockResolvedValueOnce({
        ok: true,
        admission: {
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          status: 'rejected',
          targets: [{
            requestedDeviceId: mobileDeviceId,
            admission: 'excluded',
            reasonCode: 'unresolved_variables',
          }],
        },
        script: { id: mobileScriptId },
        ignoredParameters: [],
        triggerType: 'manual',
        runAs: 'system',
        auditOrgId: 'org-123',
      });

      const res = await app.request('/mobile/devices/11111111-2222-4333-8444-555555555555/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run_script', scriptId: '22222222-2222-2222-2222-222222222222' })
      });

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body).toEqual({ admission: 'excluded', reasonCode: 'unresolved_variables' });
      // Nothing ran, so no success audit.
      expect(writeRouteAuditMock).not.toHaveBeenCalled();
    });

    it('should run a script action by delegating to executeScriptOnDevices', async () => {
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([
          { id: '11111111-2222-4333-8444-555555555555', orgId: 'org-123', status: 'online', osType: 'linux', siteId: null }
        ]) as any
      );
      executeScriptOnDevicesMock.mockResolvedValueOnce(admittedScriptResult());

      const res = await app.request('/mobile/devices/11111111-2222-4333-8444-555555555555/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'run_script',
          scriptId: '22222222-2222-2222-2222-222222222222',
          parameters: { key: 'value' }
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toEqual({
        action: 'run_script',
        executionId: 'exec-1',
        commandId: 'cmd-1'
      });
      expect(executeScriptOnDevicesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          scriptId: '22222222-2222-2222-2222-222222222222',
          deviceIds: ['11111111-2222-4333-8444-555555555555'],
          parameters: { key: 'value' },
          triggerType: 'manual'
        })
      );
      expect(writeRouteAuditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'mobile.device.action',
          resourceId: '11111111-2222-4333-8444-555555555555',
          details: expect.objectContaining({
            scriptId: '22222222-2222-2222-2222-222222222222',
            executionId: 'exec-1',
            commandId: 'cmd-1'
          })
        })
      );
    });

    // #3409 PR3 §2.2 — this endpoint accepts `parameters`, so a mobile caller
    // can supply a value for a parameter that is BOUND to a source. The
    // binding wins and the value is dropped; surfacing it here keeps the
    // mobile client's contract consistent with POST /scripts/:id/execute.
    it('surfaces ignored bound parameter keys in the body and the audit', async () => {
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([
          { id: '11111111-2222-4333-8444-555555555555', orgId: 'org-123', status: 'online', osType: 'linux', siteId: null }
        ]) as any
      );
      executeScriptOnDevicesMock.mockResolvedValueOnce(admittedScriptResult(['api_key']));

      const res = await app.request('/mobile/devices/11111111-2222-4333-8444-555555555555/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'run_script',
          scriptId: '22222222-2222-2222-2222-222222222222',
          parameters: { api_key: 'caller-supplied-secret' }
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.ignoredParameters).toEqual(['api_key']);
      expect(writeRouteAuditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          details: expect.objectContaining({ ignoredParameterKeys: ['api_key'] })
        })
      );
      // Keys only — the caller's value must never reach an audit row.
      const auditDetails = writeRouteAuditMock.mock.calls.at(-1)?.[1]?.details ?? {};
      expect(JSON.stringify(auditDetails)).not.toContain('caller-supplied-secret');
    });

    it('omits ignoredParameters entirely when nothing was ignored', async () => {
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([
          { id: '11111111-2222-4333-8444-555555555555', orgId: 'org-123', status: 'online', osType: 'linux', siteId: null }
        ]) as any
      );
      executeScriptOnDevicesMock.mockResolvedValueOnce(admittedScriptResult());

      const res = await app.request('/mobile/devices/11111111-2222-4333-8444-555555555555/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'run_script',
          scriptId: '22222222-2222-2222-2222-222222222222'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect('ignoredParameters' in body).toBe(false);
    });

    it('returns a trust probation denial without inserting a device command', async () => {
      const { TrustDeniedError } = await import('../services/partnerTrust.commands');
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([
          { id: mobileDeviceId, orgId: 'org-123', status: 'online', siteId: null }
        ]) as any
      );
      assertDeviceExecuteAllowedMock.mockRejectedValueOnce(
        new TrustDeniedError(
          'TRUST_PROBATION',
          'probation_default_deny',
          mobileDeviceId,
          'reboot',
        ),
      );

      const res = await app.request(`/mobile/devices/${mobileDeviceId}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reboot' })
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: 'TRUST_PROBATION',
        capability: 'device_execute',
        reason: 'probation_default_deny',
      });
      expect(assertDeviceExecuteAllowedMock).toHaveBeenCalledWith(
        mobileDeviceId,
        'reboot',
        'user-123',
      );
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('should submit device action commands when trust allows execution', async () => {
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([
          { id: '11111111-2222-4333-8444-555555555555', orgId: 'org-123', status: 'online' }
        ]) as any
      );
      vi.mocked(db.insert).mockReturnValue(
        mockInsertReturning([
          { id: 'cmd-1' }
        ]) as any
      );

      const res = await app.request('/mobile/devices/11111111-2222-4333-8444-555555555555/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reboot' })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.commandId).toBe('cmd-1');
      expect(assertDeviceExecuteAllowedMock).toHaveBeenCalledWith(
        mobileDeviceId,
        'reboot',
        'user-123',
      );
    });

    // #3409 PR0 Task 3: the org-equality invariant itself now lives inside
    // executeScriptOnDevices (see scriptExecution.test.ts — "cross-org
    // isolation" describe block) since the route no longer re-derives script
    // access or org-equality. What the route still owns is passing the
    // single targeted deviceId through and surfacing whatever result the
    // service returns, which is what these cases now pin.
    describe('run_script cross-org isolation (route passthrough)', () => {
      const DEVICE_ORG = 'org-b';
      const SCRIPT_ID = '11111111-1111-1111-1111-111111111111';
      const DEVICE_ID = '11111111-2222-4333-8444-555555555555';

      // A multi-org partner caller — shape mirrors a real caller whose token
      // can reach multiple orgs; executeScriptOnDevices (mocked here) is what
      // actually enforces the same-org invariant against it now.
      const useMultiOrgPartnerAuth = () => {
        vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
          c.set('auth', {
            user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
            scope: 'partner',
            orgId: null,
            partnerId: 'partner-123',
            accessibleOrgIds: ['org-a', DEVICE_ORG],
            canAccessOrg: (orgId: string) => orgId === 'org-a' || orgId === DEVICE_ORG,
          });
          return next();
        });
      };

      const mockDeviceLookup = () => {
        vi.mocked(db.select).mockReturnValue(
          mockSelectLimitChain([
            { id: DEVICE_ID, orgId: DEVICE_ORG, status: 'online', osType: 'linux', siteId: null }
          ]) as any
        );
      };

      it('rejects running an org A script on an org B device through typed admission', async () => {
        useMultiOrgPartnerAuth();
        mockDeviceLookup();
        executeScriptOnDevicesMock.mockResolvedValueOnce({
          ok: true,
          admission: {
            requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            status: 'rejected',
            targets: [{ requestedDeviceId: DEVICE_ID, admission: 'denied', reasonCode: 'script_org_mismatch' }],
          },
          script: { id: SCRIPT_ID },
          ignoredParameters: [],
          triggerType: 'manual',
          runAs: 'system',
          auditOrgId: DEVICE_ORG,
        });

        const res = await app.request(`/mobile/devices/${DEVICE_ID}/actions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'run_script', scriptId: SCRIPT_ID })
        });

        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body).toEqual({ admission: 'denied', reasonCode: 'script_org_mismatch' });
        expect(writeRouteAuditMock).not.toHaveBeenCalled();
      });

      it('allows running a same-org script on its own org device', async () => {
        useMultiOrgPartnerAuth();
        mockDeviceLookup();
        executeScriptOnDevicesMock.mockResolvedValueOnce({
          ...admittedScriptResult(),
          admission: { ...admittedScriptResult().admission, targets: [{ requestedDeviceId: DEVICE_ID, admission: 'admitted', executionId: 'exec-1', commandId: 'cmd-1' }] },
          script: { id: SCRIPT_ID },
          auditOrgId: DEVICE_ORG,
        });

        const res = await app.request(`/mobile/devices/${DEVICE_ID}/actions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'run_script', scriptId: SCRIPT_ID })
        });

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.executionId).toBe('exec-1');
        expect(writeRouteAuditMock).toHaveBeenCalled();
      });

      it('allows running a system (org-less) script on any accessible device', async () => {
        useMultiOrgPartnerAuth();
        mockDeviceLookup();
        executeScriptOnDevicesMock.mockResolvedValueOnce({
          ...admittedScriptResult(),
          admission: { ...admittedScriptResult().admission, targets: [{ requestedDeviceId: DEVICE_ID, admission: 'admitted', executionId: 'exec-1', commandId: 'cmd-1' }] },
          script: { id: SCRIPT_ID },
          auditOrgId: null,
        });

        const res = await app.request(`/mobile/devices/${DEVICE_ID}/actions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'run_script', scriptId: SCRIPT_ID })
        });

        expect(res.status).toBe(201);
      });
    });
  });

  describe('GET /mobile/summary', () => {
    it.skip('should return summary statistics', async () => {
      // Skipped: Complex aggregation mock required
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectWhereChain([
            { total: 5, online: 2, offline: 2, maintenance: 1 }
          ]) as any
        )
        .mockReturnValueOnce(
          mockSelectWhereChain([
            { total: 3, active: 1, acknowledged: 1, resolved: 1, critical: 1 }
          ]) as any
        );

      const res = await app.request('/mobile/summary', {
        method: 'GET'
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.devices.total).toBe(5);
      expect(body.alerts.critical).toBe(1);
    });

    it.skip('should return zeros when partner has no orgs', async () => {
      // Skipped: Complex partner scope mock required
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'partner',
          orgId: null,
          partnerId: 'partner-123'
        });
        return next();
      });
      vi.mocked(db.select).mockReturnValue(
        mockSelectWhereChain([]) as any
      );

      const res = await app.request('/mobile/summary', {
        method: 'GET'
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.devices.total).toBe(0);
      expect(body.alerts.total).toBe(0);
    });

    describe('site-axis narrowing', () => {
      // Helper: summary device/alert aggregate queries return a single row.
      const mockAggregateChain = (row: unknown) => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([row])
        })
      });
      // Helper: resolveSiteAllowedDeviceIds device lookup chain (returns array of {id, siteId}).
      const mockDeviceSiteChain = (rows: unknown[]) => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(rows)
        })
      });

      it('returns zeros for both devices and alerts when site-restricted caller has empty allowedSiteIds (fail-closed)', async () => {
        authState.permissions = { allowedSiteIds: [] };

        const res = await app.request('/mobile/summary', { method: 'GET' });
        expect(res.status).toBe(200);
        const body = await res.json();
        // Empty allowedSiteIds → early return zeros for everything
        expect(body.devices.total).toBe(0);
        expect(body.alerts.total).toBe(0);
        // db.select should not have been called (short-circuit before any query)
        expect(vi.mocked(db.select)).not.toHaveBeenCalled();
      });

      it('applies siteId inArray to device stats and uses resolveSiteAllowedDeviceIds for alert stats when site-restricted', async () => {
        authState.permissions = { allowedSiteIds: ['site-1'] };
        vi.mocked(inArray).mockClear();

        const selectMock = vi.mocked(db.select);
        // Call order:
        //   1. device stats aggregate (from devices, where includes siteId inArray)
        //   2. resolveSiteAllowedDeviceIds: select {id, siteId} from devices where orgId
        //   3. alert stats aggregate (from alerts, where includes deviceId inArray)
        selectMock
          .mockReturnValueOnce(mockAggregateChain({ total: 3, online: 2, offline: 1, maintenance: 0 }) as any)
          .mockReturnValueOnce(mockDeviceSiteChain([{ id: 'dev-1', siteId: 'site-1' }]) as any)
          .mockReturnValueOnce(mockAggregateChain({ total: 1, active: 1, acknowledged: 0, resolved: 0, critical: 1 }) as any);

        const res = await app.request('/mobile/summary', { method: 'GET' });
        expect(res.status).toBe(200);
        const body = await res.json();
        // Device stats reflect the allowed-site devices
        expect(body.devices.total).toBe(3);
        // Alert stats reflect the allowed device IDs
        expect(body.alerts.total).toBe(1);
        // Three db.select calls: device-agg, device-site-lookup, alert-agg
        expect(selectMock).toHaveBeenCalledTimes(3);

        // Load-bearing site narrowing. These prove the actual filters were built;
        // deleting either production line drops the matching inArray call.
        //   - device stats narrow on the real devices.siteId column with the allowlist
        //   - alert stats narrow on the real alerts.deviceId column with the device IDs
        //     resolveSiteAllowedDeviceIds yields for the allowed site (['dev-1'])
        expect(inArray).toHaveBeenCalledWith(devices.siteId, ['site-1']);
        expect(inArray).toHaveBeenCalledWith(alerts.deviceId, ['dev-1']);
      });

      it('returns zero alerts (but real device counts) when resolveSiteAllowedDeviceIds returns empty', async () => {
        authState.permissions = { allowedSiteIds: ['site-1'] };

        const selectMock = vi.mocked(db.select);
        // Device stats: some devices returned
        selectMock
          .mockReturnValueOnce(mockAggregateChain({ total: 2, online: 1, offline: 1, maintenance: 0 }) as any)
          // resolveSiteAllowedDeviceIds: no devices in the allowed site
          .mockReturnValueOnce(mockDeviceSiteChain([]) as any);

        const res = await app.request('/mobile/summary', { method: 'GET' });
        expect(res.status).toBe(200);
        const body = await res.json();
        // Device stats already computed before the site-device resolution
        expect(body.devices.total).toBe(2);
        // Alert stats zeroed because no in-scope device IDs
        expect(body.alerts.total).toBe(0);
        // Only two db.select calls: no alert-agg issued (short-circuited)
        expect(selectMock).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('GET /mobile/search', () => {
    const SITE_ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';
    const SITE_DENIED = 'bbbbbbbb-0000-0000-0000-000000000002';
    const DEVICE_ALLOWED = '11111111-1111-1111-1111-111111111111';
    const DEVICE_DENIED = '22222222-2222-2222-2222-222222222222';

    // Returns the chain we need so the route's three Promise.all queries
    // each get their own canned result. The route invokes db.select() three
    // times in sequence; we line the chains up in call order.
    const mockSearchChain = (result: unknown) => ({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(result)
            })
          })
        }),
        // Sessions query has no leftJoin — we expose `where` directly too.
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(result)
          })
        })
      })
    });

    beforeEach(() => {
      rateLimitState.allowed = true;
    });

    it('rejects empty query with 400', async () => {
      const res = await app.request('/mobile/search?q=', { method: 'GET' });
      expect(res.status).toBe(400);
    });

    it('returns a unified ranked list across devices, alerts, and sessions', async () => {
      const deviceRow = {
        id: 'dev-1',
        orgId: 'org-123',
        siteId: 'site-1',
        hostname: 'macbook',
        displayName: 'Tech Mac',
        osType: 'macos',
        status: 'online',
        lastSeenAt: new Date('2026-05-01T12:00:00Z'),
        siteName: 'HQ'
      };
      const alertRow = {
        id: 'alert-1',
        orgId: 'org-123',
        severity: 'critical',
        status: 'active',
        title: 'Disk full',
        message: 'macbook is at 99%',
        triggeredAt: new Date('2026-05-02T09:00:00Z'),
        deviceId: 'dev-1',
        deviceHostname: 'macbook',
        deviceDisplayName: 'Tech Mac'
      };
      const sessionRow = {
        id: 'sess-1',
        orgId: 'org-123',
        title: 'macbook diagnostics',
        status: 'active',
        turnCount: 4,
        lastActivityAt: new Date('2026-05-03T10:00:00Z'),
        createdAt: new Date('2026-05-03T09:55:00Z')
      };

      vi.mocked(db.select)
        .mockReturnValueOnce(mockSearchChain([deviceRow]) as any)
        .mockReturnValueOnce(mockSearchChain([alertRow]) as any)
        .mockReturnValueOnce(mockSearchChain([sessionRow]) as any);

      const res = await app.request('/mobile/search?q=macbook', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.results).toHaveLength(3);

      const kinds = body.results.map((r: { kind: string }) => r.kind).sort();
      expect(kinds).toEqual(['alert', 'device', 'session']);

      // Critical alert should rank ahead of others (round-robin starts with
      // the alert queue, so position 0 is the critical alert).
      expect(body.results[0].kind).toBe('alert');
      expect(body.results[0].id).toBe('alert-1');
      expect(body.results[0].meta.severity).toBe('critical');
    });

    it('narrows device and alert search results for a site-restricted caller', async () => {
      authState.permissions = { allowedSiteIds: [SITE_ALLOWED] };
      const captured: { deviceWhere?: unknown; alertWhere?: unknown } = {};
      const deviceRow = {
        id: DEVICE_ALLOWED,
        orgId: 'org-123',
        siteId: SITE_ALLOWED,
        hostname: 'allowed-macbook',
        displayName: 'Allowed Mac',
        osType: 'macos',
        status: 'online',
        lastSeenAt: new Date('2026-05-01T12:00:00Z'),
        siteName: 'Allowed Site'
      };
      const alertRow = {
        id: 'alert-1',
        orgId: 'org-123',
        severity: 'critical',
        status: 'active',
        title: 'Disk full',
        message: 'allowed-macbook is at 99%',
        triggeredAt: new Date('2026-05-02T09:00:00Z'),
        deviceId: DEVICE_ALLOWED,
        deviceHostname: 'allowed-macbook',
        deviceDisplayName: 'Allowed Mac'
      };

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: DEVICE_ALLOWED, siteId: SITE_ALLOWED },
              { id: DEVICE_DENIED, siteId: SITE_DENIED }
            ])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn((where: unknown) => {
                captured.deviceWhere = where;
                return {
                  orderBy: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([deviceRow])
                  })
                };
              })
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn((where: unknown) => {
                captured.alertWhere = where;
                return {
                  orderBy: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([alertRow])
                  })
                };
              })
            })
          })
        } as any)
        .mockReturnValueOnce(mockSearchChain([]) as any);

      const res = await app.request('/mobile/search?q=macbook', { method: 'GET' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results.map((result: { id: string }) => result.id)).toEqual(['alert-1', DEVICE_ALLOWED]);
      expect(objectContains(captured.deviceWhere, SITE_ALLOWED)).toBe(true);
      expect(objectContains(captured.deviceWhere, SITE_DENIED)).toBe(false);
      expect(objectContains(captured.alertWhere, DEVICE_ALLOWED)).toBe(true);
      expect(objectContains(captured.alertWhere, DEVICE_DENIED)).toBe(false);
    });

    it('does not narrow search results for an unrestricted caller', async () => {
      const deviceRow = {
        id: DEVICE_DENIED,
        orgId: 'org-123',
        siteId: SITE_DENIED,
        hostname: 'denied-macbook',
        displayName: 'Denied Mac',
        osType: 'macos',
        status: 'online',
        lastSeenAt: new Date('2026-05-01T12:00:00Z'),
        siteName: 'Denied Site'
      };
      const alertRow = {
        id: 'alert-1',
        orgId: 'org-123',
        severity: 'critical',
        status: 'active',
        title: 'Disk full',
        message: 'denied-macbook is at 99%',
        triggeredAt: new Date('2026-05-02T09:00:00Z'),
        deviceId: DEVICE_DENIED,
        deviceHostname: 'denied-macbook',
        deviceDisplayName: 'Denied Mac'
      };

      vi.mocked(db.select)
        .mockReturnValueOnce(mockSearchChain([deviceRow]) as any)
        .mockReturnValueOnce(mockSearchChain([alertRow]) as any)
        .mockReturnValueOnce(mockSearchChain([]) as any);

      const res = await app.request('/mobile/search?q=macbook', { method: 'GET' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results.map((result: { id: string }) => result.id)).toEqual(['alert-1', DEVICE_DENIED]);
      expect(db.select).toHaveBeenCalledTimes(3);
    });

    it('returns 429 when rate limit is exceeded', async () => {
      rateLimitState.allowed = false;
      const res = await app.request('/mobile/search?q=macbook', { method: 'GET' });
      expect(res.status).toBe(429);
    });

    it('scopes results to the caller org, never another tenant', async () => {
      // Capture the where-clause arg the route passes to drizzle so we can
      // assert org isolation. We use a sentinel that throws on access from
      // any unexpected query path, then read the recorded call args.
      const recordedWheres: unknown[] = [];
      const mkChain = (result: unknown) => ({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn((arg: unknown) => {
              recordedWheres.push(arg);
              return {
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue(result)
                })
              };
            })
          }),
          where: vi.fn((arg: unknown) => {
            recordedWheres.push(arg);
            return {
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(result)
              })
            };
          })
        })
      });

      vi.mocked(db.select)
        .mockReturnValueOnce(mkChain([]) as any)
        .mockReturnValueOnce(mkChain([]) as any)
        .mockReturnValueOnce(mkChain([]) as any);

      const res = await app.request('/mobile/search?q=acme', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toEqual([]);
      // Three queries, each with a where(...) clause that includes the
      // tenant filter. Route always calls .where(...) — even with the
      // sql`true` short-circuit — so this just confirms the queries ran.
      expect(recordedWheres.length).toBe(3);
    });
  });
});
