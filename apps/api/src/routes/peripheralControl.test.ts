import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { permissionGate, mfaGate, permsState } = vi.hoisted(() => ({
  permissionGate: { deny: false },
  mfaGate: { deny: false },
  permsState: { perms: undefined as { allowedSiteIds?: string[] } | undefined }
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  }
,
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  peripheralDeviceClassEnum: { enumValues: ['storage', 'all_usb', 'bluetooth', 'thunderbolt'] },
  peripheralEventTypeEnum: { enumValues: ['connected', 'disconnected', 'blocked', 'mounted_read_only', 'policy_override'] },
  peripheralPolicyActionEnum: { enumValues: ['allow', 'block', 'read_only', 'alert'] },
  peripheralPolicyTargetTypeEnum: { enumValues: ['organization', 'site', 'group', 'device'] },
  peripheralEvents: {
    id: 'id',
    orgId: 'orgId',
    deviceId: 'deviceId',
    policyId: 'policyId',
    eventType: 'eventType',
    peripheralType: 'peripheralType',
    vendor: 'vendor',
    product: 'product',
    serialNumber: 'serialNumber',
    occurredAt: 'occurredAt',
    createdAt: 'createdAt',
  },
  peripheralPolicies: {
    id: 'id',
    orgId: 'orgId',
    name: 'name',
    deviceClass: 'deviceClass',
    action: 'action',
    targetType: 'targetType',
    isActive: 'isActive',
    updatedAt: 'updatedAt'
  },
  devices: {
    id: 'id',
    orgId: 'orgId',
    siteId: 'siteId'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111',
      orgCondition: () => undefined,
      user: { id: 'user-123', email: 'test@example.com' }
    });
    c.set('permissions', permsState.perms);
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (permissionGate.deny) return c.json({ error: 'Forbidden' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (mfaGate.deny) return c.json({ error: 'MFA required' }, 403);
    return next();
  })
}));

vi.mock('../jobs/peripheralJobs', () => ({
  schedulePeripheralPolicyDistribution: vi.fn()
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn()
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_WRITE: { resource: 'organizations', action: 'write' }
  },
  canAccessSite: (perms: { allowedSiteIds?: string[] } | undefined, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId)
}));

import { db } from '../db';
import { schedulePeripheralPolicyDistribution } from '../jobs/peripheralJobs';
import { publishEvent } from '../services/eventBus';
import { peripheralControlRoutes } from './peripheralControl';

const orgId = '11111111-1111-1111-1111-111111111111';
const policyId = '22222222-2222-2222-2222-222222222222';

const basePolicy = {
  id: policyId,
  orgId,
  name: 'Block USB Storage',
  deviceClass: 'storage',
  action: 'block',
  targetType: 'organization',
  targetIds: {},
  exceptions: [],
  isActive: true,
  createdBy: 'user-123',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

describe('peripheralControl routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    permissionGate.deny = false;
    mfaGate.deny = false;
    permsState.perms = undefined;
    app = new Hono();
    app.route('/peripherals', peripheralControlRoutes);
  });

  it('rejects activity windows larger than 90 days', async () => {
    const res = await app.request(
      '/peripherals/activity?start=2026-01-01T00:00:00.000Z&end=2026-05-01T00:00:00.000Z',
      { method: 'GET' }
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('cannot exceed 90 days');
  });

  it('rejects policy mutation when permission gate fails', async () => {
    permissionGate.deny = true;

    const res = await app.request('/peripherals/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Block storage',
        deviceClass: 'storage',
        action: 'block',
        targetType: 'organization'
      })
    });

    expect(res.status).toBe(403);
  });

  it('rejects policy mutation when MFA gate fails', async () => {
    mfaGate.deny = true;

    const res = await app.request('/peripherals/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Block storage',
        deviceClass: 'storage',
        action: 'block',
        targetType: 'organization'
      })
    });

    expect(res.status).toBe(403);
  });

  it('creates a policy (happy path)', async () => {
    const created = { ...basePolicy, id: policyId };

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([created])
      })
    } as any);

    const res = await app.request('/peripherals/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Block USB Storage',
        deviceClass: 'storage',
        action: 'block',
        targetType: 'organization'
      })
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBe(policyId);
    expect(body.data.name).toBe('Block USB Storage');
    expect(body.data.deviceClass).toBe('storage');
  });

  it('updates a policy (happy path)', async () => {
    const updated = { ...basePolicy, name: 'Updated Policy', action: 'alert' };

    // getPolicyWithAccess: db.select().from().where().limit()
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([basePolicy])
        })
      })
    } as any);

    // db.update().set().where().returning()
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updated])
        })
      })
    } as any);

    const res = await app.request('/peripherals/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: policyId,
        name: 'Updated Policy',
        deviceClass: 'storage',
        action: 'alert',
        targetType: 'organization'
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('Updated Policy');
    expect(body.data.action).toBe('alert');
  });

  it('returns 404 when updating a non-existent policy', async () => {
    // getPolicyWithAccess returns empty
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([])
        })
      })
    } as any);

    const res = await app.request('/peripherals/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: policyId,
        name: 'Updated Policy',
        deviceClass: 'storage',
        action: 'block',
        targetType: 'organization'
      })
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Policy not found');
  });

  it('disables a policy (happy path)', async () => {
    const disabled = { ...basePolicy, isActive: false };

    // getPolicyWithAccess
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([basePolicy])
        })
      })
    } as any);

    // db.update().set().where().returning()
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([disabled])
        })
      })
    } as any);

    const res = await app.request(`/peripherals/policies/${policyId}/disable`, {
      method: 'POST'
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.isActive).toBe(false);
  });

  it('returns 404 when disabling a non-existent policy', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([])
        })
      })
    } as any);

    const res = await app.request(`/peripherals/policies/${policyId}/disable`, {
      method: 'POST'
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Policy not found');
  });

  it('adds an exception to a policy', async () => {
    const updatedWithException = {
      ...basePolicy,
      exceptions: [{ vendor: 'SanDisk', allow: true }]
    };

    // getPolicyWithAccess
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([basePolicy])
        })
      })
    } as any);

    // db.update().set().where().returning()
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updatedWithException])
        })
      })
    } as any);

    const res = await app.request('/peripherals/exceptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        policyId,
        operation: 'add',
        exception: {
          vendor: 'SanDisk',
          allow: true
        }
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed).toBe(1);
  });

  it('returns 404 when removing an exception with no match', async () => {
    const policyWithNoExceptions = { ...basePolicy, exceptions: [] };

    // getPolicyWithAccess
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([policyWithNoExceptions])
        })
      })
    } as any);

    const res = await app.request('/peripherals/exceptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        policyId,
        operation: 'remove',
        match: {
          vendor: 'NonExistent'
        }
      })
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('No matching exception rule found');
  });

  it('includes warning when distribution scheduling fails', async () => {
    const created = { ...basePolicy };

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([created])
      })
    } as any);

    vi.mocked(schedulePeripheralPolicyDistribution).mockRejectedValueOnce(
      new Error('Redis connection lost')
    );

    const res = await app.request('/peripherals/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Block USB Storage',
        deviceClass: 'storage',
        action: 'block',
        targetType: 'organization'
      })
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warning).toContain('distribution scheduling failed');
    expect(body.warning).toContain('Redis connection lost');
  });

  it('includes both error messages when distribution and event publish fail', async () => {
    const created = { ...basePolicy };

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([created])
      })
    } as any);

    vi.mocked(schedulePeripheralPolicyDistribution).mockRejectedValueOnce(
      new Error('Redis down')
    );
    vi.mocked(publishEvent).mockRejectedValueOnce(
      new Error('Event bus unavailable')
    );

    const res = await app.request('/peripherals/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Block USB Storage',
        deviceClass: 'storage',
        action: 'block',
        targetType: 'organization'
      })
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warning).toContain('distribution scheduling failed: Redis down');
    expect(body.warning).toContain('event publish failed: Event bus unavailable');
    expect(body.warning).toContain(';');
  });

  it('lists activity with pagination (happy path)', async () => {
    const now = new Date();
    const activityRow = {
      id: '33333333-3333-3333-3333-333333333333',
      orgId,
      deviceId: '44444444-4444-4444-4444-444444444444',
      policyId,
      eventType: 'blocked',
      peripheralType: 'storage',
      vendor: 'SanDisk',
      product: 'Ultra USB',
      serialNumber: 'SN-12345',
      occurredAt: now.toISOString(),
      createdAt: now.toISOString()
    };

    // First call: count query (db.select({count}).from().where())
    // Second call: rows query (db.select().from().where().orderBy().limit().offset())
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 1 }])
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([activityRow])
              })
            })
          })
        })
      } as any);

    const start = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const end = now.toISOString();

    const res = await app.request(
      `/peripherals/activity?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&limit=50&offset=0`,
      { method: 'GET' }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(activityRow.id);
    expect(body.pagination).toEqual({
      total: 1,
      limit: 50,
      offset: 0
    });
  });

  it('returns 400 when activity start is after end', async () => {
    const res = await app.request(
      '/peripherals/activity?start=2026-03-01T00:00:00.000Z&end=2026-02-01T00:00:00.000Z',
      { method: 'GET' }
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('start must be before or equal to end');
  });

  describe('GET /activity site-scope narrowing', () => {
    const inScopeSite = 'site-aaaa';
    const outOfScopeSite = 'site-bbbb';
    const inScopeDevice = '44444444-4444-4444-4444-444444444444';
    const outOfScopeDevice = '55555555-5555-5555-5555-555555555555';

    const activityRow = (deviceId: string) => ({
      id: '33333333-3333-3333-3333-333333333333',
      orgId,
      deviceId,
      policyId,
      eventType: 'blocked',
      peripheralType: 'storage',
      vendor: 'SanDisk',
      product: 'Ultra USB',
      serialNumber: 'SN-12345',
      occurredAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    });

    // db.select() call order when site-restricted:
    //   1. device-resolution select: .from().where() -> org devices
    //   2. count select: .from().where()
    //   3. rows select: .from().where().orderBy().limit().offset()
    function mockRestrictedSelects(orgDevices: Array<{ id: string; siteId: string }>, rows: unknown[]) {
      vi.mocked(db.select).mockReset();
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(orgDevices)
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: rows.length }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue(rows)
                })
              })
            })
          })
        } as any);
    }

    it('returns 403 when a site-restricted caller requests an out-of-scope deviceId', async () => {
      permsState.perms = { allowedSiteIds: [inScopeSite] };
      mockRestrictedSelects(
        [
          { id: inScopeDevice, siteId: inScopeSite },
          { id: outOfScopeDevice, siteId: outOfScopeSite }
        ],
        []
      );

      const res = await app.request(
        `/peripherals/activity?deviceId=${outOfScopeDevice}`,
        { method: 'GET' }
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Device not found or access denied');
    });

    it('allows a site-restricted caller to read an in-scope deviceId', async () => {
      permsState.perms = { allowedSiteIds: [inScopeSite] };
      mockRestrictedSelects(
        [
          { id: inScopeDevice, siteId: inScopeSite },
          { id: outOfScopeDevice, siteId: outOfScopeSite }
        ],
        [activityRow(inScopeDevice)]
      );

      const res = await app.request(
        `/peripherals/activity?deviceId=${inScopeDevice}`,
        { method: 'GET' }
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].deviceId).toBe(inScopeDevice);
    });

    it('narrows results to in-scope devices for a site-restricted caller (no explicit deviceId)', async () => {
      permsState.perms = { allowedSiteIds: [inScopeSite] };
      mockRestrictedSelects(
        [
          { id: inScopeDevice, siteId: inScopeSite },
          { id: outOfScopeDevice, siteId: outOfScopeSite }
        ],
        [activityRow(inScopeDevice)]
      );

      const res = await app.request('/peripherals/activity', { method: 'GET' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].deviceId).toBe(inScopeDevice);
    });

    it('short-circuits to an empty result when the caller has no in-scope devices', async () => {
      permsState.perms = { allowedSiteIds: ['site-with-no-devices'] };
      // Only the device-resolution select runs; no count/rows query.
      vi.mocked(db.select).mockReset();
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: outOfScopeDevice, siteId: outOfScopeSite }
          ])
        })
      } as any);

      const res = await app.request('/peripherals/activity', { method: 'GET' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
      // No count/rows queries should have been issued beyond device resolution.
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
    });

    it('does not narrow for an unrestricted caller (no allowedSiteIds)', async () => {
      // No perms set -> unrestricted. Only count + rows selects run (no device resolution).
      vi.mocked(db.select).mockReset();
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([activityRow(outOfScopeDevice)])
                })
              })
            })
          })
        } as any);

      const res = await app.request('/peripherals/activity', { method: 'GET' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      // Unrestricted: exactly 2 selects (count + rows), no device-resolution query.
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
    });
  });
});
