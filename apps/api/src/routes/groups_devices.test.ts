import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { groupRoutes } from './groups';

const GROUP_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GROUP_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID_2 = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEVICE_ID_2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SITE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

vi.mock('../services', () => ({}));

// These org-only route regressions do not enter the separate OD5 read view.
// Preserve ownership/locking helpers used by the real membership code, while
// keeping the new cross-owner lookups out of their queued Drizzle responses.
vi.mock('../services/deviceGroupOwnership', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/deviceGroupOwnership')>(),
  resolveOrgSessionPartnerId: vi.fn().mockResolvedValue(null),
  readPartnerGroupsForOrgSession: vi.fn().mockResolvedValue([]),
  findPartnerOwnedGroupIds: vi.fn().mockResolvedValue([]),
}));


vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

const { schedulePeripheralPolicyDevice } = vi.hoisted(() => ({
  schedulePeripheralPolicyDevice: vi.fn().mockResolvedValue('job-id'),
}));
vi.mock('../jobs/peripheralJobs', () => ({
  schedulePeripheralPolicyDevice,
}));

vi.mock('../services/filterEngine', () => ({
  evaluateFilterWithPreview: vi.fn().mockResolvedValue({
    totalCount: 1,
    devices: [{
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      hostname: 'host-1',
      displayName: 'Host One',
      osType: 'windows',
      status: 'online',
      lastSeenAt: new Date('2026-01-01')
    }],
    evaluatedAt: new Date('2026-01-01')
  }),
  extractFieldsFromFilter: vi.fn().mockReturnValue(['osType']),
  validateFilter: vi.fn().mockReturnValue({ valid: true, errors: [] })
}));

vi.mock('../services/groupMembership', async () => {
  const actual = await vi.importActual<typeof import('../services/groupMembership')>(
    '../services/groupMembership'
  );
  return {
    evaluateGroupMembership: vi.fn().mockResolvedValue(undefined),
    pinDeviceToGroup: vi.fn().mockResolvedValue(undefined),
    pruneGroupMembershipsOutsideSite: vi.fn().mockResolvedValue(undefined),
    // Real: the extracted tenancy guard + membership insert that POST
    // /:id/devices used to carry inline. These tests are that logic's
    // coverage, exercised against the already-mocked `../db` / `../db/schema`.
    validateManualMembershipDevices: actual.validateManualMembershipDevices,
    addManualGroupMemberships: actual.addManualGroupMemberships,
    // Spied so the route tests can assert WHICH ids reach the delete (site gate).
    removeManualGroupMemberships: vi.fn(actual.removeManualGroupMemberships)
  };
});

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
,
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  // groupMembership schedules peripheral reconciliation after commit (#10521 W2b);
  // there is no transaction here, so run it immediately.
  runAfterDbContextCommit: vi.fn((_label: string, work: () => unknown) => { void work(); }),
}));

vi.mock('../db/schema', () => ({
  deviceGroups: {
    id: 'id',
    orgId: 'orgId',
    siteId: 'siteId',
    name: 'name',
    type: 'type',
    rules: 'rules',
    filterConditions: 'filterConditions',
    filterFieldsUsed: 'filterFieldsUsed',
    parentId: 'parentId',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt'
  },
  deviceGroupMemberships: {
    deviceId: 'deviceId',
    groupId: 'groupId',
    isPinned: 'isPinned',
    addedAt: 'addedAt',
    addedBy: 'addedBy'
  },
  devices: {
    id: 'id',
    orgId: 'orgId',
    hostname: 'hostname',
    displayName: 'displayName',
    status: 'status',
    osType: 'osType'
  },
  groupMembershipLog: {
    id: 'id',
    groupId: 'groupId',
    deviceId: 'deviceId',
    action: 'action',
    reason: 'reason',
    createdAt: 'createdAt'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      partnerId: null,
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111'
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { validateFilter } from '../services/filterEngine';
import { writeRouteAudit } from '../services/auditEvents';
import { removeManualGroupMemberships } from '../services/groupMembership';

function makeGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: GROUP_ID,
    orgId: ORG_ID,
    siteId: null,
    name: 'Test Group',
    type: 'static',
    rules: null,
    filterConditions: null,
    filterFieldsUsed: [],
    parentId: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides
  };
}


describe('groups routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization',
        orgId: ORG_ID,
        partnerId: null,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID
      });
      return next();
    });
    app = new Hono();
    app.route('/groups', groupRoutes);
  });

  // ----------------------------------------------------------------
  // GET /:id/devices - List devices in group
  // ----------------------------------------------------------------
  describe('GET /groups/:id/devices', () => {
    it('should list devices in a group', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeGroup()])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockResolvedValue([
                  {
                    deviceId: DEVICE_ID,
                    isPinned: false,
                    addedAt: new Date('2026-01-01'),
                    addedBy: 'manual',
                    hostname: 'host-1',
                    displayName: 'Host One',
                    status: 'online',
                    osType: 'windows'
                  }
                ])
              })
            })
          })
        } as any);

      const res = await app.request(`/groups/${GROUP_ID}/devices`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].deviceId).toBe(DEVICE_ID);
      expect(body.total).toBe(1);
    });

    it('should return 404 for non-existent group', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}/devices`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });
  });

  // ----------------------------------------------------------------
  // POST /:id/devices - Add devices to group
  // ----------------------------------------------------------------
  describe('POST /groups/:id/devices', () => {
    it('should add devices to a static group', async () => {
      vi.mocked(db.select)
        // getGroupWithAccess
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeGroup()])
            })
          })
        } as any)
        // Device verification
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: DEVICE_ID, orgId: ORG_ID }
            ])
          })
        } as any)
        // Existing memberships
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([])
          })
        } as any)
        // getDeviceCountForGroup
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any);

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockResolvedValue(undefined)
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}/devices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID] })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.added).toBe(1);
    });

    it('should reject adding devices to a dynamic group', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeGroup({ type: 'dynamic' })])
          })
        })
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}/devices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID] })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('dynamic group');
    });

    it('should reject devices from different org', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeGroup()])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: DEVICE_ID, orgId: ORG_ID_2 }
            ])
          })
        } as any);

      const res = await app.request(`/groups/${GROUP_ID}/devices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID] })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('invalid');
    });

    it('should validate required deviceIds', async () => {
      // Readability is established before body validation.
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([makeGroup()])
        }) })
      } as never);
      const res = await app.request(`/groups/${GROUP_ID}/devices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ deviceIds: [] })
      });

      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------------
  // DELETE /:id/devices/:deviceId - Remove device from group
  // ----------------------------------------------------------------
  describe('DELETE /groups/:id/devices/:deviceId', () => {
    it('should remove a device from a static group', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeGroup()])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ deviceId: DEVICE_ID, groupId: GROUP_ID, isPinned: false }])
            })
          })
        } as any);

      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockResolvedValue(undefined)
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}/devices/${DEVICE_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.removed).toBe(true);
      expect(schedulePeripheralPolicyDevice).toHaveBeenCalledWith(
        DEVICE_ID,
        'manual_membership_changed',
      );
    });

    it('should reject removing device from a dynamic group', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeGroup({ type: 'dynamic' })])
          })
        })
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}/devices/${DEVICE_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('dynamic group');
    });

    it('should return 404 when device is not a member', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeGroup()])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as any);

      const res = await app.request(`/groups/${GROUP_ID}/devices/${DEVICE_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });
  });

  // ----------------------------------------------------------------
  // POST /:id/devices/remove - Remove several devices from a static group (#9866)
  // ----------------------------------------------------------------
  describe('POST /groups/:id/devices/remove', () => {
    const DEVICE_ID_3 = '99999999-9999-4999-8999-999999999999';
    const OTHER_SITE = '88888888-8888-4888-8888-888888888888';

    function mockGroup(overrides: Record<string, unknown> = {}) {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeGroup(overrides)])
          })
        })
      } as any);
    }

    function mockDeviceSites(rows: Array<{ id: string; siteId: string }>) {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) })
      } as any);
    }

    function mockDelete(removedIds: string[]) {
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue(removedIds.map((deviceId) => ({ deviceId })))
        })
      } as any);
    }

    const post = (deviceIds: string[]) => app.request(`/groups/${GROUP_ID}/devices/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ deviceIds })
    });

    it('removes the members in one statement and reports each device', async () => {
      mockGroup();
      mockDelete([DEVICE_ID, DEVICE_ID_2]);

      const res = await post([DEVICE_ID, DEVICE_ID_2, DEVICE_ID_3]);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.results).toEqual([
        { deviceId: DEVICE_ID, outcome: 'removed' },
        { deviceId: DEVICE_ID_2, outcome: 'removed' },
        { deviceId: DEVICE_ID_3, outcome: 'not_member' }
      ]);
      expect(body.data.summary).toEqual({ removed: 2, notMember: 1, forbidden: 0, total: 3 });
      expect(db.delete).toHaveBeenCalledTimes(1);
      expect(schedulePeripheralPolicyDevice).toHaveBeenCalledTimes(2);
      expect(schedulePeripheralPolicyDevice).toHaveBeenCalledWith(DEVICE_ID, 'manual_membership_changed');
      expect(schedulePeripheralPolicyDevice).toHaveBeenCalledWith(DEVICE_ID_2, 'manual_membership_changed');
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        orgId: ORG_ID,
        action: 'device_group.device.remove',
        resourceId: GROUP_ID,
        details: expect.objectContaining({ removedCount: 2, deviceIds: [DEVICE_ID, DEVICE_ID_2] })
      }));
    });

    it('treats a repeated id as one device', async () => {
      mockGroup();
      mockDelete([DEVICE_ID]);
      const res = await post([DEVICE_ID, DEVICE_ID]);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.results).toEqual([{ deviceId: DEVICE_ID, outcome: 'removed' }]);
      expect(body.data.summary.total).toBe(1);
    });

    it("refuses, per device, a device outside a site-bound group's site (same rule as the single DELETE)", async () => {
      mockGroup({ siteId: SITE_ID });
      mockDeviceSites([{ id: DEVICE_ID, siteId: SITE_ID }, { id: DEVICE_ID_2, siteId: OTHER_SITE }]);
      mockDelete([DEVICE_ID]);

      const res = await post([DEVICE_ID, DEVICE_ID_2]);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.results).toEqual([
        { deviceId: DEVICE_ID, outcome: 'removed' },
        { deviceId: DEVICE_ID_2, outcome: 'forbidden' }
      ]);
      expect(body.data.summary).toEqual({ removed: 1, notMember: 0, forbidden: 1, total: 2 });
      // The refused device never reaches the delete (not just reported as refused).
      expect(removeManualGroupMemberships).toHaveBeenCalledWith(expect.objectContaining({ deviceIds: [DEVICE_ID] }));
    });

    function restrictCallerToSites(allowedSiteIds: string[]) {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'organization',
          orgId: ORG_ID,
          partnerId: null,
          accessibleOrgIds: [ORG_ID],
          canAccessOrg: (orgId: string) => orgId === ORG_ID
        });
        c.set('permissions', { allowedSiteIds });
        return next();
      });
    }

    it('refuses, per device, a device the site-restricted caller cannot reach', async () => {
      restrictCallerToSites([SITE_ID]);
      mockGroup({ siteId: SITE_ID });
      // DEVICE_ID_2 reads back absent (another org, or deleted): refused, never removed.
      mockDeviceSites([{ id: DEVICE_ID, siteId: SITE_ID }]);
      mockDelete([DEVICE_ID]);

      const res = await post([DEVICE_ID, DEVICE_ID_2]);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.results).toEqual([
        { deviceId: DEVICE_ID, outcome: 'removed' },
        { deviceId: DEVICE_ID_2, outcome: 'forbidden' }
      ]);
      expect(removeManualGroupMemberships).toHaveBeenCalledWith(expect.objectContaining({ deviceIds: [DEVICE_ID] }));
    });

    it('403s, without writing, a site-restricted caller on a group bound to a site outside their list', async () => {
      restrictCallerToSites([SITE_ID]);
      mockGroup({ siteId: OTHER_SITE });

      const res = await post([DEVICE_ID]);

      expect(res.status).toBe(403);
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('403s a site-restricted caller on an org-wide group (fails closed, like the single DELETE)', async () => {
      restrictCallerToSites([SITE_ID]);
      mockGroup({ siteId: null });

      const res = await post([DEVICE_ID]);

      expect(res.status).toBe(403);
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('writes nothing when no requested device is removable', async () => {
      mockGroup({ siteId: SITE_ID });
      mockDeviceSites([{ id: DEVICE_ID, siteId: OTHER_SITE }]);

      const res = await post([DEVICE_ID]);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.summary).toEqual({ removed: 0, notMember: 0, forbidden: 1, total: 1 });
      expect(db.delete).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    it('rejects a dynamic group without writing', async () => {
      mockGroup({ type: 'dynamic' });
      const res = await post([DEVICE_ID]);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('dynamic group');
      expect(db.delete).not.toHaveBeenCalled();
    });

    // Partner-owned groups (read-only membership, unknown-id for org users) are
    // pinned for this route in groups_partnerOwned.test.ts with the other
    // membership writes.

    it('rejects an empty list and more ids than the cap, without writing', async () => {
      mockGroup();
      expect((await post([])).status).toBe(400);
      mockGroup();
      const tooMany = Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      expect((await post(tooMany)).status).toBe(400);
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('accepts exactly the cap (500 ids)', async () => {
      mockGroup();
      mockDelete([]);
      const atCap = Array.from({ length: 500 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      const res = await post(atCap);
      expect(res.status).toBe(200);
      expect((await res.json()).data.summary).toEqual({ removed: 0, notMember: 500, forbidden: 0, total: 500 });
    });
  });

});
