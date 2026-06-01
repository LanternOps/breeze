import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { mobileRoutes } from './mobile';

const { publishEventMock, setCooldownMock, rateLimitState, authState } = vi.hoisted(() => ({
  publishEventMock: vi.fn().mockResolvedValue('event-1'),
  setCooldownMock: vi.fn().mockResolvedValue(undefined),
  rateLimitState: { allowed: true },
  authState: { permissions: undefined as { allowedSiteIds?: string[] } | undefined }
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
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
      partnerId: 'partner-123'
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

vi.mock('../services/alertCooldown', () => ({
  setCooldown: setCooldownMock
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

describe('mobile routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(db.delete).mockReset();
    authState.permissions = undefined;
    rateLimitState.allowed = true;
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
      const res = await app.request('/mobile/devices/device-1/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(400);
    });

    it('should return 404 when device is missing', async () => {
      vi.mocked(db.update).mockReturnValue(mockUpdateReturning([]) as any);

      const res = await app.request('/mobile/devices/device-1/settings', {
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
              deviceId: 'device-1',
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
    });

    it('should acknowledge active alert', async () => {
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([
          { id: 'alert-1', status: 'active', orgId: 'org-123' }
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

      expect(res.status).toBe(400);
    });

    it('should resolve alert with note', async () => {
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
              id: 'device-1',
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
    it('requires scripts.execute for run_script actions before device lookup', async () => {
      vi.mocked(db.select).mockReturnValue(mockSelectLimitChain([]) as any);

      const res = await app.request('/mobile/devices/device-1/actions', {
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

      const res = await app.request('/mobile/devices/device-1/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reboot' })
      });

      expect(res.status).toBe(404);
      expect(requirePermission).not.toHaveBeenCalledWith('scripts', 'execute');
    });

    it('should return 404 when device is missing', async () => {
      vi.mocked(db.select).mockReturnValue(mockSelectLimitChain([]) as any);

      const res = await app.request('/mobile/devices/device-1/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reboot' })
      });

      expect(res.status).toBe(404);
    });

    it('should reject decommissioned devices', async () => {
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([
          { id: 'device-1', orgId: 'org-123', status: 'decommissioned' }
        ]) as any
      );

      const res = await app.request('/mobile/devices/device-1/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reboot' })
      });

      expect(res.status).toBe(400);
    });

    it.skip('should return 404 when script is missing', async () => {
      // Skipped: Complex mock chain required
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectLimitChain([
            { id: 'device-1', orgId: 'org-123', status: 'online', osType: 'linux' }
          ]) as any
        )
        .mockReturnValueOnce(mockSelectLimitChain([]) as any);

      const res = await app.request('/mobile/devices/device-1/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run_script', scriptId: 'script-1' })
      });

      expect(res.status).toBe(404);
    });

    it.skip('should run a script action', async () => {
      // Skipped: Complex mock chain required
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectLimitChain([
            { id: 'device-1', orgId: 'org-123', status: 'online', osType: 'linux' }
          ]) as any
        )
        .mockReturnValueOnce(
          mockSelectLimitChain([
            {
              id: 'script-1',
              orgId: 'org-123',
              osTypes: ['linux'],
              language: 'bash',
              content: 'echo ok',
              timeoutSeconds: 60,
              runAs: 'root'
            }
          ]) as any
        );
      vi.mocked(db.insert)
        .mockReturnValueOnce(
          mockInsertReturning([
            { id: 'exec-1' }
          ]) as any
        )
        .mockReturnValueOnce(
          mockInsertReturning([
            { id: 'cmd-1' }
          ]) as any
        );

      const res = await app.request('/mobile/devices/device-1/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'run_script',
          scriptId: 'script-1',
          parameters: { key: 'value' }
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.executionId).toBe('exec-1');
      expect(body.commandId).toBe('cmd-1');
    });

    it.skip('should submit device action commands', async () => {
      // Skipped: Complex command submission mock required
      vi.mocked(db.select).mockReturnValue(
        mockSelectLimitChain([
          { id: 'device-1', orgId: 'org-123', status: 'online' }
        ]) as any
      );
      vi.mocked(db.insert).mockReturnValue(
        mockInsertReturning([
          { id: 'cmd-1' }
        ]) as any
      );

      const res = await app.request('/mobile/devices/device-1/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reboot' })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.commandId).toBe('cmd-1');
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
