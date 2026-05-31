import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { groupRoutes } from './groups';

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
  writeAuditEvent: vi.fn()
}));

vi.mock('../services/filterEngine', () => ({
  evaluateFilterWithPreview: vi.fn(),
  extractFieldsFromFilter: vi.fn(() => []),
  validateFilter: vi.fn(() => ({ valid: true }))
}));

vi.mock('../services/groupMembership', () => ({
  evaluateGroupMembership: vi.fn(),
  pinDeviceToGroup: vi.fn()
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve())
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve())
    }))
  }
}));

vi.mock('../db/schema', () => ({
  deviceGroups: {
    id: 'device_groups.id',
    orgId: 'device_groups.org_id',
    siteId: 'device_groups.site_id',
    type: 'device_groups.type',
    parentId: 'device_groups.parent_id',
    createdAt: 'device_groups.created_at'
  },
  deviceGroupMemberships: {
    deviceId: 'device_group_memberships.device_id',
    groupId: 'device_group_memberships.group_id',
    isPinned: 'device_group_memberships.is_pinned',
    addedAt: 'device_group_memberships.added_at',
    addedBy: 'device_group_memberships.added_by'
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.org_id',
    siteId: 'devices.site_id',
    hostname: 'devices.hostname',
    displayName: 'devices.display_name',
    status: 'devices.status',
    osType: 'devices.os_type'
  },
  groupMembershipLog: {
    id: 'group_membership_log.id',
    groupId: 'group_membership_log.group_id',
    deviceId: 'group_membership_log.device_id',
    action: 'group_membership_log.action',
    reason: 'group_membership_log.reason',
    createdAt: 'group_membership_log.created_at'
  },
  sites: { id: 'sites.id', orgId: 'sites.org_id' }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn((...scopes: string[]) => (c: any, next: any) => {
    const auth = c.get('auth');
    if (!scopes.includes(auth?.scope)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  }),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';

const GROUP_ID = '00000000-0000-0000-0000-0000000000a1';
const GROUP_SITE_X = '00000000-0000-0000-0000-0000000000a2';
const GROUP_SITE_Y = '00000000-0000-0000-0000-0000000000a3';
const DEVICE_IN_SITE_X = '00000000-0000-0000-0000-0000000000d1';
const DEVICE_IN_SITE_Y = '00000000-0000-0000-0000-0000000000d2';
const ORG = '11111111-1111-1111-1111-111111111111';
const SITE_X = '22222222-2222-2222-2222-222222222222';
const SITE_Y = '33333333-3333-3333-3333-333333333333';
const DATE = new Date('2026-01-01T00:00:00.000Z');

describe('group routes', () => {
  let app: Hono;

  // The bulk-add path queries the DB in this order:
  //   1. getGroupWithAccess -> select deviceGroups (.limit)
  //   2. select device {id, orgId} by inArray (terminal promise on .where)
  //   3. (per device) canAccessDeviceSite -> select devices.siteId (.limit)
  //   4. select existing memberships (terminal promise on .where)
  //   5. getDeviceCountForGroup -> select count (terminal promise on .where)
  // We drive these by chaining db.select mock return values in order.
  const mockGroupSelect = () =>
    ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([
            { id: GROUP_ID, orgId: ORG, name: 'Static Group', type: 'static' }
          ])
        })
      })
    } as any);

  // Returns a select whose terminal `.where` resolves to the given rows
  // (used for the device-by-inArray lookup and existing-memberships lookup).
  const mockWhereResolves = (rows: unknown[]) =>
    ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows)
      })
    } as any);

  // canAccessDeviceSite's per-device select: from().where().limit() -> [{ siteId }]
  const mockSiteSelect = (siteId: string | null) =>
    ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(siteId === null ? [] : [{ siteId }])
        })
      })
    } as any);

  const mockWhereResolvesOrLimits = (whereRows: unknown[], limitRows: unknown[]) =>
    ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(limitRows),
          then: (resolve: any, reject: any) => Promise.resolve(whereRows).then(resolve, reject)
        })
      })
    } as any);

  const mockOrderedRows = (rows: unknown[]) =>
    ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue(rows)
        })
      })
    } as any);

  const mockGroupedRows = (rows: unknown[]) => {
    const grouped = { groupBy: vi.fn().mockResolvedValue(rows) };
    const filtered = { where: vi.fn().mockReturnValue(grouped) };
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(grouped),
        innerJoin: vi.fn().mockReturnValue(filtered)
      })
    } as any;
  };

  const mockJoinedWhereRows = (rows: unknown[]) => {
    const filtered = { where: vi.fn().mockResolvedValue(rows) };
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
        innerJoin: vi.fn().mockReturnValue(filtered)
      })
    } as any;
  };

  const mockJoinedOrderedRows = (rows: unknown[]) => {
    const ordered = { orderBy: vi.fn().mockResolvedValue(rows) };
    const filtered = { where: vi.fn().mockReturnValue(ordered) };
    return {
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue(filtered),
        leftJoin: vi.fn().mockReturnValue(filtered)
      })
    } as any;
  };

  const mockJoinedPagedRows = (rows: unknown[]) => {
    const paged = {
      offset: vi.fn().mockResolvedValue(rows)
    };
    const limited = {
      limit: vi.fn().mockReturnValue(paged)
    };
    const ordered = {
      orderBy: vi.fn().mockReturnValue(limited)
    };
    const filtered = {
      where: vi.fn().mockReturnValue(ordered)
    };
    return {
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue(filtered),
        innerJoin: vi.fn().mockReturnValue(filtered)
      })
    } as any;
  };

  const makeGroup = (id: string, siteId: string | null) => ({
    id,
    orgId: ORG,
    siteId,
    name: `Group ${id.slice(-2)}`,
    type: 'static',
    rules: null,
    filterConditions: null,
    filterFieldsUsed: [],
    parentId: null,
    createdAt: DATE,
    updatedAt: DATE
  });

  const setAuth = (allowedSiteIds: string[] | undefined) => {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        token: {},
        partnerId: 'partner-123',
        orgId: ORG,
        scope: 'organization',
        accessibleOrgIds: [ORG],
        orgCondition: () => undefined,
        canAccessOrg: () => true
      } as any);
      c.set('permissions', {
        permissions: [],
        partnerId: null,
        orgId: ORG,
        roleId: 'role-123',
        scope: 'organization',
        allowedSiteIds
      } as any);
      return next();
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    }) as any);
    app = new Hono();
    app.route('/groups', groupRoutes);
  });

  describe('POST /groups/:id/devices (bulk-add) site-scope confinement', () => {
    it('rejects (403) when a confined user adds a device whose site (site-y) is out of scope', async () => {
      setAuth([SITE_X]);
      const insertSpy = vi.mocked(db.insert);
      vi.mocked(db.select)
        // 1. group lookup
        .mockReturnValueOnce(mockGroupSelect())
        // 2. device {id, orgId} lookup — device belongs to the right org
        .mockReturnValueOnce(mockWhereResolves([{ id: DEVICE_IN_SITE_Y, orgId: ORG }]))
        // 3. canAccessDeviceSite per-device lookup — site-y, NOT allowed
        .mockReturnValueOnce(mockSiteSelect(SITE_Y));

      const res = await app.request(`/groups/${GROUP_ID}/devices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_IN_SITE_Y] })
      });

      expect(res.status).toBe(403);
      // Fail closed — nothing inserted.
      expect(insertSpy).not.toHaveBeenCalled();
    });

    it('rejects (403) the whole batch when one of several devices is out of scope (partial batch)', async () => {
      setAuth([SITE_X]);
      const insertSpy = vi.mocked(db.insert);
      vi.mocked(db.select)
        // 1. group lookup
        .mockReturnValueOnce(mockGroupSelect())
        // 2. device {id, orgId} lookup — both devices belong to the right org
        .mockReturnValueOnce(mockWhereResolves([
          { id: DEVICE_IN_SITE_X, orgId: ORG },
          { id: DEVICE_IN_SITE_Y, orgId: ORG }
        ]))
        // 3. canAccessDeviceSite for device-x — site-x, allowed
        .mockReturnValueOnce(mockSiteSelect(SITE_X))
        // 4. canAccessDeviceSite for device-y — site-y, NOT allowed
        .mockReturnValueOnce(mockSiteSelect(SITE_Y));

      const res = await app.request(`/groups/${GROUP_ID}/devices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_IN_SITE_X, DEVICE_IN_SITE_Y] })
      });

      expect(res.status).toBe(403);
      // Fail closed — the whole batch is rejected, NOT the in-scope device
      // (device-x) partially added.
      expect(insertSpy).not.toHaveBeenCalled();
    });

    it('allows a confined user to add a device whose site (site-x) is in scope', async () => {
      setAuth([SITE_X]);
      vi.mocked(db.select)
        // 1. group lookup
        .mockReturnValueOnce(mockGroupSelect())
        // 2. device lookup
        .mockReturnValueOnce(mockWhereResolves([{ id: DEVICE_IN_SITE_X, orgId: ORG }]))
        // 3. canAccessDeviceSite per-device lookup — site-x, allowed
        .mockReturnValueOnce(mockSiteSelect(SITE_X))
        // 4. existing memberships lookup — none
        .mockReturnValueOnce(mockWhereResolves([]))
        // 5. getDeviceCountForGroup
        .mockReturnValueOnce(mockWhereResolves([{ count: 1 }]));

      const res = await app.request(`/groups/${GROUP_ID}/devices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_IN_SITE_X] })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.added).toBe(1);
    });

    it('fails closed (403) for a confined user when a device has no site', async () => {
      setAuth([SITE_X]);
      const insertSpy = vi.mocked(db.insert);
      vi.mocked(db.select)
        .mockReturnValueOnce(mockGroupSelect())
        .mockReturnValueOnce(mockWhereResolves([{ id: DEVICE_IN_SITE_Y, orgId: ORG }]))
        // canAccessDeviceSite: device row missing siteId -> []
        .mockReturnValueOnce(mockSiteSelect(null));

      const res = await app.request(`/groups/${GROUP_ID}/devices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_IN_SITE_Y] })
      });

      expect(res.status).toBe(403);
      expect(insertSpy).not.toHaveBeenCalled();
    });

    it('does not site-gate an unconfined user (allowedSiteIds undefined)', async () => {
      setAuth(undefined);
      vi.mocked(db.select)
        // 1. group lookup
        .mockReturnValueOnce(mockGroupSelect())
        // 2. device lookup (device in any site)
        .mockReturnValueOnce(mockWhereResolves([{ id: DEVICE_IN_SITE_Y, orgId: ORG }]))
        // canAccessDeviceSite short-circuits (no allowedSiteIds) -> no site select.
        // 3. existing memberships lookup
        .mockReturnValueOnce(mockWhereResolves([]))
        // 4. getDeviceCountForGroup
        .mockReturnValueOnce(mockWhereResolves([{ count: 1 }]));

      const res = await app.request(`/groups/${GROUP_ID}/devices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_IN_SITE_Y] })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.added).toBe(1);
    });
  });

  describe('GET /groups site-scope confinement', () => {
    it('rejects (403) when a confined user requests an out-of-scope explicit siteId', async () => {
      setAuth([SITE_X]);

      const res = await app.request(`/groups?siteId=${SITE_Y}`);

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Device not found or access denied');
    });

    it('narrows group rows and included membership device IDs to the allowed site', async () => {
      setAuth([SITE_X]);
      vi.mocked(db.select)
        .mockReturnValueOnce(mockOrderedRows([
          makeGroup(GROUP_ID, null),
          makeGroup(GROUP_SITE_X, SITE_X),
          makeGroup(GROUP_SITE_Y, SITE_Y)
        ]))
        .mockReturnValueOnce(mockGroupedRows([
          { groupId: GROUP_ID, count: 1 },
          { groupId: GROUP_SITE_X, count: 1 }
        ]))
        .mockReturnValueOnce(mockJoinedWhereRows([
          { groupId: GROUP_ID, deviceId: DEVICE_IN_SITE_X, siteId: SITE_X },
          { groupId: GROUP_ID, deviceId: DEVICE_IN_SITE_Y, siteId: SITE_Y },
          { groupId: GROUP_SITE_X, deviceId: DEVICE_IN_SITE_X, siteId: SITE_X },
          { groupId: GROUP_SITE_X, deviceId: DEVICE_IN_SITE_Y, siteId: SITE_Y },
          { groupId: GROUP_SITE_Y, deviceId: DEVICE_IN_SITE_Y, siteId: SITE_Y }
        ]));

      const res = await app.request('/groups?includeMemberships=true');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.map((group: any) => group.id)).toEqual([GROUP_ID, GROUP_SITE_X]);
      expect(body.data.find((group: any) => group.id === GROUP_ID).deviceIds).toEqual([DEVICE_IN_SITE_X]);
      expect(body.data.find((group: any) => group.id === GROUP_SITE_X).deviceIds).toEqual([DEVICE_IN_SITE_X]);
      expect(body.total).toBe(2);
    });

    it('does not narrow group rows or memberships for an unrestricted user', async () => {
      setAuth(undefined);
      vi.mocked(db.select)
        .mockReturnValueOnce(mockOrderedRows([
          makeGroup(GROUP_ID, null),
          makeGroup(GROUP_SITE_X, SITE_X),
          makeGroup(GROUP_SITE_Y, SITE_Y)
        ]))
        .mockReturnValueOnce(mockGroupedRows([
          { groupId: GROUP_ID, count: 2 },
          { groupId: GROUP_SITE_X, count: 2 },
          { groupId: GROUP_SITE_Y, count: 1 }
        ]))
        .mockReturnValueOnce(mockJoinedWhereRows([
          { groupId: GROUP_ID, deviceId: DEVICE_IN_SITE_X, siteId: SITE_X },
          { groupId: GROUP_ID, deviceId: DEVICE_IN_SITE_Y, siteId: SITE_Y },
          { groupId: GROUP_SITE_X, deviceId: DEVICE_IN_SITE_X, siteId: SITE_X },
          { groupId: GROUP_SITE_X, deviceId: DEVICE_IN_SITE_Y, siteId: SITE_Y },
          { groupId: GROUP_SITE_Y, deviceId: DEVICE_IN_SITE_Y, siteId: SITE_Y }
        ]));

      const res = await app.request('/groups?includeMemberships=true');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.map((group: any) => group.id)).toEqual([GROUP_ID, GROUP_SITE_X, GROUP_SITE_Y]);
      expect(body.data.find((group: any) => group.id === GROUP_ID).deviceIds).toEqual([
        DEVICE_IN_SITE_X,
        DEVICE_IN_SITE_Y
      ]);
      expect(body.total).toBe(3);
    });
  });

  describe('GET /groups/:id/devices site-scope confinement', () => {
    it('narrows memberships to devices in the allowed site', async () => {
      setAuth([SITE_X]);
      vi.mocked(db.select)
        .mockReturnValueOnce(mockGroupSelect())
        .mockReturnValueOnce(mockJoinedOrderedRows([
          {
            deviceId: DEVICE_IN_SITE_X,
            siteId: SITE_X,
            hostname: 'in-scope',
            displayName: 'In Scope',
            status: 'online',
            osType: 'windows',
            isPinned: false,
            addedAt: DATE,
            addedBy: 'manual'
          },
          {
            deviceId: DEVICE_IN_SITE_Y,
            siteId: SITE_Y,
            hostname: 'out-of-scope',
            displayName: 'Out of Scope',
            status: 'online',
            osType: 'windows',
            isPinned: false,
            addedAt: DATE,
            addedBy: 'manual'
          }
        ]));

      const res = await app.request(`/groups/${GROUP_ID}/devices`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.map((device: any) => device.deviceId)).toEqual([DEVICE_IN_SITE_X]);
      expect(body.total).toBe(1);
    });

    it('does not narrow memberships for an unrestricted user', async () => {
      setAuth(undefined);
      vi.mocked(db.select)
        .mockReturnValueOnce(mockGroupSelect())
        .mockReturnValueOnce(mockJoinedOrderedRows([
          {
            deviceId: DEVICE_IN_SITE_X,
            siteId: SITE_X,
            hostname: 'in-scope',
            displayName: 'In Scope',
            status: 'online',
            osType: 'windows',
            isPinned: false,
            addedAt: DATE,
            addedBy: 'manual'
          },
          {
            deviceId: DEVICE_IN_SITE_Y,
            siteId: SITE_Y,
            hostname: 'out-of-scope',
            displayName: 'Out of Scope',
            status: 'online',
            osType: 'windows',
            isPinned: false,
            addedAt: DATE,
            addedBy: 'manual'
          }
        ]));

      const res = await app.request(`/groups/${GROUP_ID}/devices`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.map((device: any) => device.deviceId)).toEqual([
        DEVICE_IN_SITE_X,
        DEVICE_IN_SITE_Y
      ]);
      expect(body.total).toBe(2);
    });
  });

  describe('GET /groups/:id/membership-log site-scope confinement', () => {
    it('rejects (403) when a confined user requests an out-of-scope explicit deviceId', async () => {
      setAuth([SITE_X]);
      vi.mocked(db.select)
        .mockReturnValueOnce(mockGroupSelect())
        .mockReturnValueOnce(mockWhereResolvesOrLimits([{ count: 0 }], [{ siteId: SITE_Y }]))
        .mockReturnValueOnce(mockJoinedPagedRows([]));

      const res = await app.request(`/groups/${GROUP_ID}/membership-log?deviceId=${DEVICE_IN_SITE_Y}`);

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Device not found or access denied');
    });

    it('narrows log entries to devices in the allowed site', async () => {
      setAuth([SITE_X]);
      vi.mocked(db.select)
        .mockReturnValueOnce(mockGroupSelect())
        .mockReturnValueOnce(mockJoinedWhereRows([{ count: 1 }]))
        .mockReturnValueOnce(mockJoinedPagedRows([
          {
            id: '00000000-0000-0000-0000-0000000000f1',
            groupId: GROUP_ID,
            deviceId: DEVICE_IN_SITE_X,
            siteId: SITE_X,
            action: 'added',
            reason: 'manual',
            createdAt: DATE,
            hostname: 'in-scope',
            displayName: 'In Scope'
          },
          {
            id: '00000000-0000-0000-0000-0000000000f2',
            groupId: GROUP_ID,
            deviceId: DEVICE_IN_SITE_Y,
            siteId: SITE_Y,
            action: 'removed',
            reason: 'manual',
            createdAt: DATE,
            hostname: 'out-of-scope',
            displayName: 'Out of Scope'
          }
        ]));

      const res = await app.request(`/groups/${GROUP_ID}/membership-log`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.map((entry: any) => entry.deviceId)).toEqual([DEVICE_IN_SITE_X]);
      expect(body.total).toBe(1);
    });

    it('does not narrow log entries for an unrestricted user', async () => {
      setAuth(undefined);
      vi.mocked(db.select)
        .mockReturnValueOnce(mockGroupSelect())
        .mockReturnValueOnce(mockWhereResolves([{ count: 2 }]))
        .mockReturnValueOnce(mockJoinedPagedRows([
          {
            id: '00000000-0000-0000-0000-0000000000f1',
            groupId: GROUP_ID,
            deviceId: DEVICE_IN_SITE_X,
            siteId: SITE_X,
            action: 'added',
            reason: 'manual',
            createdAt: DATE,
            hostname: 'in-scope',
            displayName: 'In Scope'
          },
          {
            id: '00000000-0000-0000-0000-0000000000f2',
            groupId: GROUP_ID,
            deviceId: DEVICE_IN_SITE_Y,
            siteId: SITE_Y,
            action: 'removed',
            reason: 'manual',
            createdAt: DATE,
            hostname: 'out-of-scope',
            displayName: 'Out of Scope'
          }
        ]));

      const res = await app.request(`/groups/${GROUP_ID}/membership-log`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.map((entry: any) => entry.deviceId)).toEqual([
        DEVICE_IN_SITE_X,
        DEVICE_IN_SITE_Y
      ]);
      expect(body.total).toBe(2);
    });
  });
});
