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
  deviceGroups: {},
  deviceGroupMemberships: {},
  devices: { id: 'devices.id', siteId: 'devices.siteId' },
  groupMembershipLog: {},
  sites: {}
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
const DEVICE_IN_SITE_X = '00000000-0000-0000-0000-0000000000d1';
const DEVICE_IN_SITE_Y = '00000000-0000-0000-0000-0000000000d2';
const ORG = '11111111-1111-1111-1111-111111111111';

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

  const setAuth = (allowedSiteIds: string[] | undefined) => {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        token: {},
        partnerId: 'partner-123',
        orgId: ORG,
        scope: 'partner',
        accessibleOrgIds: [ORG],
        orgCondition: () => undefined,
        canAccessOrg: () => true
      } as any);
      c.set('permissions', {
        scope: 'partner',
        allowedSiteIds
      } as any);
      return next();
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/groups', groupRoutes);
  });

  describe('POST /groups/:id/devices (bulk-add) site-scope confinement', () => {
    it('rejects (403) when a confined user adds a device whose site (site-y) is out of scope', async () => {
      setAuth(['site-x']);
      const insertSpy = vi.mocked(db.insert);
      vi.mocked(db.select)
        // 1. group lookup
        .mockReturnValueOnce(mockGroupSelect())
        // 2. device {id, orgId} lookup — device belongs to the right org
        .mockReturnValueOnce(mockWhereResolves([{ id: DEVICE_IN_SITE_Y, orgId: ORG }]))
        // 3. canAccessDeviceSite per-device lookup — site-y, NOT allowed
        .mockReturnValueOnce(mockSiteSelect('site-y'));

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
      setAuth(['site-x']);
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
        .mockReturnValueOnce(mockSiteSelect('site-x'))
        // 4. canAccessDeviceSite for device-y — site-y, NOT allowed
        .mockReturnValueOnce(mockSiteSelect('site-y'));

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
      setAuth(['site-x']);
      vi.mocked(db.select)
        // 1. group lookup
        .mockReturnValueOnce(mockGroupSelect())
        // 2. device lookup
        .mockReturnValueOnce(mockWhereResolves([{ id: DEVICE_IN_SITE_X, orgId: ORG }]))
        // 3. canAccessDeviceSite per-device lookup — site-x, allowed
        .mockReturnValueOnce(mockSiteSelect('site-x'))
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
      setAuth(['site-x']);
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
});
