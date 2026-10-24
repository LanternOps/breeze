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
    partnerId: 'partnerId',
    name: 'name',
    deviceClass: 'deviceClass',
    action: 'action',
    targetType: 'targetType',
    priority: 'priority',
    isActive: 'isActive',
    updatedAt: 'updatedAt'
  },
  devices: {
    id: 'id',
    orgId: 'orgId',
    siteId: 'siteId',
    hostname: 'hostname',
    displayName: 'displayName'
  },
  organizations: {
    id: 'id',
    partnerId: 'partnerId'
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
    // NOTE: authMiddleware does NOT populate `permissions` in production — only
    // requirePermission does. Keeping this faithful to prod ensures a route that
    // relies on `permissions` for site-scoping but lacks a permission gate fails.
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (permissionGate.deny) return c.json({ error: 'Forbidden' }, 403);
    // Mirror prod: requirePermission is the gate that populates `permissions`.
    c.set('permissions', permsState.perms);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (mfaGate.deny) return c.json({ error: 'MFA required' }, 403);
    return next();
  })
}));

vi.mock('../jobs/peripheralJobs', () => ({
  resolvePeripheralPolicyDeviceIds: vi.fn().mockResolvedValue(['device-1']),
  schedulePeripheralPolicyDevices: vi.fn().mockResolvedValue(['job-1']),
}));

vi.mock('../services/peripheralEffectivePolicy', () => ({
  loadAndResolveEffectivePeripheralPolicySet: vi.fn(),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn()
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
    DEVICES_READ: { resource: 'devices', action: 'read' }
  },
  canAccessSite: (perms: { allowedSiteIds?: string[] } | undefined, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId)
}));

import { db } from '../db';
import { schedulePeripheralPolicyDevices } from '../jobs/peripheralJobs';
import { publishEvent } from '../services/eventBus';
import { loadAndResolveEffectivePeripheralPolicySet } from '../services/peripheralEffectivePolicy';
import { authMiddleware } from '../middleware/auth';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { peripheralControlRoutes } from './peripheralControl';

const orgId = '11111111-1111-1111-1111-111111111111';
const policyId = '22222222-2222-2222-2222-222222222222';
const partnerId = '66666666-6666-6666-6666-666666666666';

const basePolicy = {
  id: policyId,
  orgId,
  name: 'Block USB Storage',
  deviceClass: 'storage',
  action: 'block',
  targetType: 'organization',
  priority: 100,
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
    // clearAllMocks keeps default implementations; reset so a fallback set in
    // one test cannot leak into the next.
    vi.mocked(db.select).mockReset();
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
    expect(schedulePeripheralPolicyDevices).toHaveBeenCalledWith(
      ['device-1'],
      'policy-created',
    );
  });

  it.each([-1, 1001, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe policy priority %s', async (priority) => {
    const res = await app.request('/peripherals/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Block USB Storage',
        deviceClass: 'storage',
        action: 'block',
        targetType: 'organization',
        priority,
      }),
    });

    expect(res.status).toBe(400);
  });

  it('persists and returns an explicitly selected safe priority', async () => {
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn((values) => ({
        returning: vi.fn().mockResolvedValue([{ ...basePolicy, ...values, id: policyId }]),
      })),
    } as any);

    const res = await app.request('/peripherals/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Block USB Storage',
        deviceClass: 'storage',
        action: 'block',
        targetType: 'organization',
        priority: 37,
      }),
    });

    expect(res.status).toBe(201);
    expect((await res.json()).data.priority).toBe(37);
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

  // #9620: the web form cannot edit targeting, so an update that omits
  // targetType/targetIds must leave the stored targeting unchanged instead of
  // silently widening the policy to the whole organization.
  describe('update targeting (#9620)', () => {
    const siteA = '33333333-3333-3333-3333-333333333333';
    const siteB = '44444444-4444-4444-4444-444444444444';
    const sitePolicy = { ...basePolicy, targetType: 'site', targetIds: { siteIds: [siteA, siteB] } };

    function mockUpdate(existing: Record<string, unknown>) {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([existing])
          })
        })
      } as any);
      const set = vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...existing, ...values }])
        })
      }));
      vi.mocked(db.update).mockReturnValue({ set } as any);
      return set;
    }

    function postUpdate(extra: Record<string, unknown> = {}) {
      return app.request('/peripherals/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: policyId, name: 'Renamed', deviceClass: 'storage', action: 'block', ...extra })
      });
    }

    it('keeps a site-targeted policy site-targeted when the update omits targeting', async () => {
      const set = mockUpdate(sitePolicy);
      const res = await postUpdate();

      expect(res.status).toBe(200);
      const written = set.mock.calls[0]![0];
      expect(written.targetType).toBe('site');
      expect(written.targetIds).toEqual({ siteIds: [siteA, siteB] });
      expect(written.name).toBe('Renamed');
    });

    it('keeps the stored targetIds when only targetType is resent unchanged', async () => {
      const set = mockUpdate(sitePolicy);
      const res = await postUpdate({ targetType: 'site' });

      expect(res.status).toBe(200);
      expect(set.mock.calls[0]![0].targetIds).toEqual({ siteIds: [siteA, siteB] });
    });

    it('clears targetIds when the update switches targetType without naming new targets', async () => {
      const set = mockUpdate(sitePolicy);
      const res = await postUpdate({ targetType: 'organization' });

      expect(res.status).toBe(200);
      const written = set.mock.calls[0]![0];
      expect(written.targetType).toBe('organization');
      expect(written.targetIds).toEqual({ siteIds: [], groupIds: [], deviceIds: [] });
    });

    it('applies explicit targeting on update', async () => {
      const set = mockUpdate(sitePolicy);
      const res = await postUpdate({ targetType: 'site', targetIds: { siteIds: [siteA] } });

      expect(res.status).toBe(200);
      expect(set.mock.calls[0]![0].targetIds).toEqual({ siteIds: [siteA], groupIds: [], deviceIds: [] });
    });

    it('keeps stored exceptions when the update omits exceptions', async () => {
      const set = mockUpdate({ ...sitePolicy, exceptions: [{ vendor: 'SanDisk', allow: true }] });
      const res = await postUpdate();

      expect(res.status).toBe(200);
      expect(set.mock.calls[0]![0]).not.toHaveProperty('exceptions');
    });

    it('clears exceptions when the update sends an explicit empty array', async () => {
      const set = mockUpdate({ ...sitePolicy, exceptions: [{ vendor: 'SanDisk', allow: true }] });
      const res = await postUpdate({ exceptions: [] });

      expect(res.status).toBe(200);
      expect(set.mock.calls[0]![0].exceptions).toEqual([]);
    });

    it('still defaults a create without targeting to the whole organization', async () => {
      const values = vi.fn((v: Record<string, unknown>) => ({
        returning: vi.fn().mockResolvedValue([{ ...basePolicy, ...v }])
      }));
      vi.mocked(db.insert).mockReturnValue({ values } as any);

      const res = await app.request('/peripherals/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New', deviceClass: 'storage', action: 'block' })
      });

      expect(res.status).toBe(201);
      expect(values.mock.calls[0]![0].targetType).toBe('organization');
      expect(values.mock.calls[0]![0].targetIds).toEqual({ siteIds: [], groupIds: [], deviceIds: [] });
    });
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

  it('includes warning when device reconciliation scheduling fails', async () => {
    const created = { ...basePolicy };

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([created])
      })
    } as any);

    vi.mocked(schedulePeripheralPolicyDevices).mockRejectedValueOnce(
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
    expect(body.warning).toContain('reconciliation scheduling failed for 1 device(s)');
  });

  it('includes both error messages when reconciliation and event publish fail', async () => {
    const created = { ...basePolicy };

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([created])
      })
    } as any);

    vi.mocked(schedulePeripheralPolicyDevices).mockRejectedValueOnce(
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
    expect(body.warning).toContain('reconciliation scheduling failed for 1 device(s)');
    expect(body.warning).toContain(`event publish failed for 1/1 org(s): ${orgId}`);
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
      } as any)
      // Batched name lookups (#9621): devices, then policies.
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: activityRow.deviceId, hostname: 'host-a', displayName: 'Front Desk' }])
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: policyId, name: 'Block USB Storage' }])
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
    expect(body.data[0].deviceName).toBe('Front Desk');
    expect(body.data[0].policyName).toBe('Block USB Storage');
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
    // Name lookups (#9621) fall through to a default empty result.
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) })
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

    it('returns 403 on GET /policies when caller lacks devices.read', async () => {
      permissionGate.deny = true;

      const res = await app.request('/peripherals/policies', { method: 'GET' });

      expect(res.status).toBe(403);
    });

    it('returns 403 on GET /policies/:id when caller lacks devices.read', async () => {
      permissionGate.deny = true;

      const res = await app.request(`/peripherals/policies/${policyId}`, { method: 'GET' });

      expect(res.status).toBe(403);
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

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) })
      } as any);

      const res = await app.request('/peripherals/activity', { method: 'GET' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      // Unrestricted: count + rows + the two name lookups (devices, policies),
      // and no site device-resolution query.
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(4);
    });
  });

  describe('GET /devices/:deviceId/effective (#9621)', () => {
    const deviceId = '44444444-4444-4444-4444-444444444444';
    const siteId = '55555555-5555-5555-5555-555555555555';
    const deviceLookup = (rows: unknown[]) => ({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }) })
    });

    it("returns only the device's effective policies, with names", async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(deviceLookup([{ id: deviceId, orgId, siteId }]) as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ id: policyId, name: 'Block USB Storage', targetType: 'site' }]) })
        } as any);
      vi.mocked(loadAndResolveEffectivePeripheralPolicySet).mockResolvedValue({
        identity: { deviceId, orgId, partnerId, siteId, groupIds: [] },
        effectivePolicies: [{
          policyId, source: 'partner', effectiveClass: 'storage', configuredClass: 'storage',
          action: 'block', priority: 100, exceptions: [],
        }],
      } as any);

      const res = await app.request(`/peripherals/devices/${deviceId}/effective`, { method: 'GET' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([{
        id: policyId, name: 'Block USB Storage', source: 'partner', deviceClass: 'storage',
        action: 'block', targetType: 'site', priority: 100,
      }]);
      expect(loadAndResolveEffectivePeripheralPolicySet).toHaveBeenCalledWith(deviceId);
    });

    it('404s (not an empty list) when the resolver cannot find the device org', async () => {
      vi.mocked(db.select).mockReturnValueOnce(deviceLookup([{ id: deviceId, orgId, siteId }]) as any);
      vi.mocked(loadAndResolveEffectivePeripheralPolicySet).mockResolvedValue(null);
      const res = await app.request(`/peripherals/devices/${deviceId}/effective`, { method: 'GET' });
      expect(res.status).toBe(404);
    });

    it('returns an empty list when no policy applies', async () => {
      vi.mocked(db.select).mockReturnValueOnce(deviceLookup([{ id: deviceId, orgId, siteId }]) as any);
      vi.mocked(loadAndResolveEffectivePeripheralPolicySet).mockResolvedValue({
        identity: { deviceId, orgId, partnerId, siteId, groupIds: [] },
        effectivePolicies: [],
      } as any);
      const res = await app.request(`/peripherals/devices/${deviceId}/effective`, { method: 'GET' });
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual([]);
    });

    it("404s for a device outside the caller's orgs without resolving anything", async () => {
      vi.mocked(db.select).mockReturnValueOnce(
        deviceLookup([{ id: deviceId, orgId: '99999999-9999-9999-9999-999999999999', siteId }]) as any
      );
      const res = await app.request(`/peripherals/devices/${deviceId}/effective`, { method: 'GET' });
      expect(res.status).toBe(404);
      expect(loadAndResolveEffectivePeripheralPolicySet).not.toHaveBeenCalled();
    });

    it("404s for a device outside a site-restricted caller's sites", async () => {
      permsState.perms = { allowedSiteIds: ['66666666-0000-0000-0000-000000000000'] };
      vi.mocked(db.select).mockReturnValueOnce(deviceLookup([{ id: deviceId, orgId, siteId }]) as any);
      const res = await app.request(`/peripherals/devices/${deviceId}/effective`, { method: 'GET' });
      expect(res.status).toBe(404);
      expect(loadAndResolveEffectivePeripheralPolicySet).not.toHaveBeenCalled();
    });
  });

  describe('policy read RBAC (devices.read)', () => {
    it('allows GET /policies when caller has devices.read', async () => {
      // permissionGate.deny defaults to false -> requirePermission passes.
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
                  offset: vi.fn().mockResolvedValue([basePolicy])
                })
              })
            })
          })
        } as any);

      const res = await app.request('/peripherals/policies', { method: 'GET' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(policyId);
      expect(body.data[0].priority).toBe(100);
    });

    it("includes the selected org's partner-wide rows when orgId is given (#9621)", async () => {
      let rowsWhere: unknown;
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 1 }]) })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation((w: unknown) => {
              rowsWhere = w;
              return {
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({ offset: vi.fn().mockResolvedValue([basePolicy]) })
                })
              };
            })
          })
        } as any);

      const res = await app.request(`/peripherals/policies?orgId=${orgId}`, { method: 'GET' });
      expect(res.status).toBe(200);

      const { PgDialect } = await import('drizzle-orm/pg-core');
      const { sql: rendered, params } = new PgDialect().sqlToQuery(rowsWhere as any);
      // org rows OR partner-wide rows (org_id IS NULL) of the selected org's partner
      expect(rendered).toContain(
        '($1 = $2 OR ($3 IS NULL AND $4 = (SELECT $5 FROM $6 WHERE $7 = $8)))',
      );
      // [orgId col, orgId, orgId col, partnerId col, org.partnerId, organizations, org.id, orgId]
      expect(params.filter((p) => p === orgId)).toHaveLength(2);
      expect(params).toContain('partnerId');
    });

    it('allows GET /policies/:id when caller has devices.read', async () => {
      // getPolicyWithAccess: db.select().from().where().limit()
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([basePolicy])
          })
        })
      } as any);

      const res = await app.request(`/peripherals/policies/${policyId}`, { method: 'GET' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(policyId);
    });
  });

  // ----------------------------------------------------------------
  // Org-owned create by a partner with TWO accessible orgs (#8338).
  // Every other fixture here has a single accessible org, which
  // resolveOrgIdForWrite fills in on its own, so the "no org named"
  // 400 can only be reached with two.
  // ----------------------------------------------------------------
  describe('org-owned create names its organization (#8338)', () => {
    const orgB = '33333333-3333-3333-3333-333333333333';

    function setTwoOrgPartnerAuth() {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'partner',
          orgId: null,
          partnerId,
          partnerOrgAccess: 'all',
          accessibleOrgIds: [orgId, orgB],
          canAccessOrg: (id: string) => id === orgId || id === orgB,
          orgCondition: () => undefined,
          user: { id: 'user-partner', email: 'partner@example.com' }
        });
        return next();
      });
    }

    const createBody = (extra: Record<string, unknown> = {}) => JSON.stringify({
      name: 'Block USB Storage',
      deviceClass: 'storage',
      action: 'block',
      targetType: 'organization',
      ...extra
    });

    it('creates the policy when the body names an accessible org', async () => {
      setTwoOrgPartnerAuth();
      const insertValues = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ ...basePolicy, orgId: orgB }])
      });
      vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ id: orgB }]) })
      } as any);

      const res = await app.request('/peripherals/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: createBody({ orgId: orgB })
      });

      expect(res.status).toBe(201);
      expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ orgId: orgB }));
    });

    it('returns 403 when the body names an org the caller cannot access', async () => {
      setTwoOrgPartnerAuth();
      const res = await app.request('/peripherals/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: createBody({ orgId: '44444444-4444-4444-4444-444444444444' })
      });

      expect(res.status).toBe(403);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('returns 400 naming orgId when the body omits it', async () => {
      setTwoOrgPartnerAuth();
      const res = await app.request('/peripherals/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: createBody()
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('orgId');
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // Partner-wide dual-ownership gate (#2131): a policy with orgId null +
  // partnerId set is only mutable by a caller with
  // canManagePartnerWidePolicies(auth) === true (system scope, or partner
  // scope with partnerOrgAccess 'all'). PR review flagged the 403 gates in
  // this route as unit-untested — only real-DB integration suites (which
  // don't run in the required CI job) covered them.
  // ----------------------------------------------------------------
  describe('partner-wide ownership gate (#2131)', () => {
    function setPartnerAuth(partnerOrgAccess: 'all' | 'selected') {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'partner',
          orgId: null,
          partnerId,
          partnerOrgAccess,
          accessibleOrgIds: [orgId],
          canAccessOrg: (id: string) => id === orgId,
          orgCondition: () => undefined,
          user: { id: 'user-partner', email: 'partner@example.com' }
        });
        return next();
      });
    }

    it('returns 403 updating a partner-wide policy when the partner caller lacks partnerOrgAccess=all', async () => {
      setPartnerAuth('selected');

      const existingPartnerWidePolicy = { ...basePolicy, orgId: null, partnerId };
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([existingPartnerWidePolicy])
          })
        })
      } as any);

      const res = await app.request('/peripherals/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: policyId,
          name: 'Updated name',
          deviceClass: 'storage',
          action: 'block',
          targetType: 'organization'
        })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('returns 403 creating a partner-wide policy when the partner caller lacks partnerOrgAccess=all', async () => {
      setPartnerAuth('selected');

      const res = await app.request('/peripherals/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerScope: 'partner',
          name: 'Partner-wide block',
          deviceClass: 'storage',
          action: 'block',
          targetType: 'organization'
        })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('creates a partner-wide policy (orgId null, partnerId set) when the partner caller has partnerOrgAccess=all', async () => {
      setPartnerAuth('all');

      const createdPartnerWidePolicy = { ...basePolicy, orgId: null, partnerId };
      const insertValues = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([createdPartnerWidePolicy])
      });
      vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

      // resolvePolicyTargetOrgIds: db.select({id}).from(organizations).where(...)
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: orgId }])
        })
      } as any);

      const res = await app.request('/peripherals/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerScope: 'partner',
          name: 'Partner-wide block',
          deviceClass: 'storage',
          action: 'block',
          targetType: 'organization'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.orgId).toBeNull();
      expect(body.data.partnerId).toBe(partnerId);
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: null, partnerId })
      );
    });

    it('returns 403 disabling a partner-wide policy when the partner caller lacks partnerOrgAccess=all', async () => {
      setPartnerAuth('selected');

      const existingPartnerWidePolicy = { ...basePolicy, orgId: null, partnerId };
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([existingPartnerWidePolicy])
          })
        })
      } as any);

      const res = await app.request(`/peripherals/policies/${policyId}/disable`, {
        method: 'POST'
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
      expect(db.update).not.toHaveBeenCalled();
    });
  });
});
