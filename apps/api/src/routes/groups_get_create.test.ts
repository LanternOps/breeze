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
const SITE_ID_2 = '12121212-1212-4121-8121-121212121212';

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../jobs/peripheralJobs', () => ({
  schedulePeripheralPolicyDevice: vi.fn().mockResolvedValue(undefined),
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
    // Real: the extracted tenancy guard + membership insert that group-create
    // (#3159) and POST /:id/devices now share. These tests are that logic's
    // coverage, exercised against the already-mocked `../db` / `../db/schema`.
    validateManualMembershipDevices: actual.validateManualMembershipDevices,
    addManualGroupMemberships: actual.addManualGroupMemberships
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
  sites: {
    id: 'id',
    orgId: 'orgId'
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
import { writeRouteAudit } from '../services/auditEvents';
import { authMiddleware } from '../middleware/auth';
import { validateFilter } from '../services/filterEngine';
import { evaluateGroupMembership } from '../services/groupMembership';

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

  function restrictToSite(siteId = SITE_ID) {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization',
        orgId: ORG_ID,
        partnerId: null,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID
      });
      c.set('permissions', { allowedSiteIds: [siteId] });
      return next();
    });
  }

  // ----------------------------------------------------------------
  // GET /:id - Get single group
  // ----------------------------------------------------------------
  describe('GET /groups/:id', () => {
    it('should return a group by ID', async () => {
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
            where: vi.fn().mockResolvedValue([{ count: 5 }])
          })
        } as any);

      const res = await app.request(`/groups/${GROUP_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(GROUP_ID);
      expect(body.data.name).toBe('Test Group');
    });

    it('should return 404 when group not found', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('not found');
    });

    it('should return 404 for group belonging to different org (multi-tenant isolation)', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeGroup({ orgId: ORG_ID_2 })])
          })
        })
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });

    it('should reject invalid UUID param', async () => {
      const res = await app.request('/groups/not-a-uuid', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------------
  // POST / - Create group
  // ----------------------------------------------------------------
  describe('POST /groups', () => {
    it('rejects an org-wide group for a site-restricted caller before insert', async () => {
      restrictToSite();

      const res = await app.request('/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Org-wide Group' })
      });

      expect(res.status).toBe(403);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects a sibling-site group for a site-restricted caller before insert', async () => {
      restrictToSite();
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: SITE_ID_2 }])
          })
        })
      } as any);

      const res = await app.request('/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Sibling Group', siteId: SITE_ID_2 })
      });

      expect(res.status).toBe(403);
      expect(db.insert).not.toHaveBeenCalled();
    });
    it('should create a static group for org-scoped user', async () => {
      const created = makeGroup();
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created])
        })
      } as any);

      const res = await app.request('/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Test Group' })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.id).toBe(GROUP_ID);
      expect(body.data.type).toBe('static');
    });

    it('should validate required fields (missing name)', async () => {
      const res = await app.request('/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(400);
    });

    it('should reject when org user has no orgId', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'organization',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: [],
          canAccessOrg: () => false
        });
        return next();
      });

      const res = await app.request('/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Test Group' })
      });

      expect(res.status).toBe(403);
    });

    it('should reject partner creating group for inaccessible org', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'partner@example.com', name: 'Partner' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID],
          canAccessOrg: (orgId: string) => orgId === ORG_ID
        });
        return next();
      });

      const res = await app.request('/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Group', orgId: ORG_ID_2 })
      });

      expect(res.status).toBe(403);
    });

    it('creates a group for a multi-org partner using the orgId query param (fetchWithAuth path)', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'partner@example.com', name: 'Partner' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID, ORG_ID_2],
          canAccessOrg: (orgId: string) => orgId === ORG_ID || orgId === ORG_ID_2
        });
        return next();
      });

      const valuesSpy = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([makeGroup({ orgId: ORG_ID_2 })])
      });
      vi.mocked(db.insert).mockReturnValueOnce({ values: valuesSpy } as any);

      const res = await app.request(`/groups?orgId=${ORG_ID_2}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Query-scoped Group' })
      });

      expect(res.status).toBe(201);
      expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_ID_2 }));
    });

    it('rejects a multi-org partner with no orgId in body or query', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'partner@example.com', name: 'Partner' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID, ORG_ID_2],
          canAccessOrg: (orgId: string) => orgId === ORG_ID || orgId === ORG_ID_2
        });
        return next();
      });

      const res = await app.request('/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'No Org Group' })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('orgId is required when partner has multiple organizations');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects an inaccessible org supplied via the query param', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'partner@example.com', name: 'Partner' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID],
          canAccessOrg: (orgId: string) => orgId === ORG_ID
        });
        return next();
      });

      const res = await app.request(`/groups?orgId=${ORG_ID_2}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Cross-tenant Group' })
      });

      expect(res.status).toBe(403);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('prefers a body orgId over the query param', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'partner@example.com', name: 'Partner' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID, ORG_ID_2],
          canAccessOrg: (orgId: string) => orgId === ORG_ID || orgId === ORG_ID_2
        });
        return next();
      });

      const valuesSpy = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([makeGroup({ orgId: ORG_ID })])
      });
      vi.mocked(db.insert).mockReturnValueOnce({ values: valuesSpy } as any);

      const res = await app.request(`/groups?orgId=${ORG_ID_2}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Body-scoped Group', orgId: ORG_ID })
      });

      expect(res.status).toBe(201);
      expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_ID }));
    });

    it('should require orgId for system scope', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'admin-1', email: 'admin@example.com', name: 'Admin' },
          scope: 'system',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: null,
          canAccessOrg: () => true
        });
        return next();
      });

      const res = await app.request('/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Group' })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('orgId is required');
    });

    it('should validate filter conditions for dynamic group', async () => {
      vi.mocked(validateFilter).mockReturnValueOnce({ valid: false, errors: ['Invalid field'] });

      const res = await app.request('/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Dynamic Group',
          type: 'dynamic',
          filterConditions: {
            operator: 'AND',
            conditions: [{ field: 'invalid', operator: 'equals', value: 'x' }]
          }
        })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Invalid filter');
    });

    // Regression guard for the silent zero-row materialization: the route used
    // to call `evaluateGroupMembership(id).catch(...)` without awaiting it. The
    // detached promise resumed only AFTER the request's withDbAccessContext
    // transaction had committed and released its pooled connection, so its next
    // query was stranded on a dead transaction handle and never ran — no rows,
    // no rejection, no log. Holding the evaluation open here proves the handler
    // genuinely waits for it, which is what keeps the write inside the caller's
    // live org-scoped RLS context.
    it('waits for dynamic membership materialization before responding', async () => {
      const created = makeGroup({
        type: 'dynamic',
        filterConditions: { operator: 'AND', conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }] }
      });
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([created]) })
      } as any);
      // Earlier cases in this file leave unconsumed `mockReturnValueOnce`
      // entries on db.select, and clearAllMocks does not drain that queue.
      vi.mocked(db.select).mockReset();
      // getDeviceCountForGroup, read AFTER materialization finishes.
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 3 }]) })
      } as any);

      let releaseEvaluation!: () => void;
      const evaluationHeld = new Promise<void>((resolve) => { releaseEvaluation = resolve; });
      vi.mocked(evaluateGroupMembership).mockReturnValueOnce(evaluationHeld as any);

      let settled = false;
      const pending = Promise.resolve(app.request('/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Dynamic Group',
          type: 'dynamic',
          filterConditions: { operator: 'AND', conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }] }
        })
      })).then((res: Response) => { settled = true; return res; });

      // Let the event loop drain: if the route were still fire-and-forget it
      // would already have responded here.
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);

      releaseEvaluation();
      const res = await pending;

      expect(res.status).toBe(201);
      expect(evaluateGroupMembership).toHaveBeenCalledWith(GROUP_ID);
      const body = await res.json();
      // The response carries the real materialized count, not a hardcoded 0.
      expect(body.data.deviceCount).toBe(3);
    });

    it('still returns 201 (and logs) when materialization fails', async () => {
      const created = makeGroup({
        type: 'dynamic',
        filterConditions: { operator: 'AND', conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }] }
      });
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([created]) })
      } as any);
      vi.mocked(db.select).mockReset();
      vi.mocked(evaluateGroupMembership).mockRejectedValueOnce(new Error('boom'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await app.request('/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Dynamic Group',
          type: 'dynamic',
          filterConditions: { operator: 'AND', conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }] }
        })
      });

      expect(res.status).toBe(201);
      expect(errorSpy).toHaveBeenCalled();
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain(GROUP_ID);
      errorSpy.mockRestore();
    });

    it('should validate parent group exists and belongs to same org', async () => {
      // Parent group lookup returns null (not found)
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Child Group',
          parentId: GROUP_ID_2
        })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Parent group not found');
    });

    it('should reject siteId outside the group organization', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Site Group',
          siteId: SITE_ID
        })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Site not found');
      expect(db.insert).not.toHaveBeenCalled();
    });

    // ----------------------------------------------------------------
    // #3159 — static group creation
    // ----------------------------------------------------------------
    // Earlier cases in this file leave unconsumed `mockReturnValueOnce` entries
    // on db.select and `vi.clearAllMocks()` in the outer `beforeEach` does not
    // drain that queue — every test here starts with an explicit
    // `db.select.mockReset()`.
    describe('#3159 static group creation', () => {
      it('accepts an explicit filterConditions: null', async () => {
        vi.mocked(db.select).mockReset();
        const valuesMock = vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([makeGroup({ type: 'static', filterConditions: null })])
        });
        vi.mocked(db.insert).mockReturnValueOnce({ values: valuesMock } as any);

        const res = await app.request('/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ name: 'Static', type: 'static', filterConditions: null })
        });

        // The headline regression: before the fix this 400'd with
        // "filterConditions: Invalid input: expected object, received null".
        expect(res.status).toBe(201);
        expect(valuesMock).toHaveBeenCalledTimes(1);
        const [groupInsert] = valuesMock.mock.calls;
        if (!groupInsert) throw new Error('the group insert was never called');
        expect(groupInsert[0]).toMatchObject({ filterConditions: null });
      });

      it('accepts an omitted filterConditions', async () => {
        vi.mocked(db.select).mockReset();
        vi.mocked(db.insert).mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([makeGroup({ type: 'static' })])
          })
        } as any);

        const res = await app.request('/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ name: 'Static', type: 'static' })
        });

        expect(res.status).toBe(201);
      });

      it('accepts a filter object for a dynamic group', async () => {
        vi.mocked(db.select).mockReset();
        // getDeviceCountForGroup, read after the (mocked) evaluateGroupMembership.
        vi.mocked(db.select).mockReturnValueOnce({
          from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 2 }]) })
        } as any);
        const filterConditions = {
          operator: 'AND' as const,
          conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }]
        };
        vi.mocked(db.insert).mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([makeGroup({ type: 'dynamic', filterConditions })])
          })
        } as any);

        const res = await app.request('/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ name: 'Dynamic', type: 'dynamic', filterConditions })
        });

        // Proves widening the field to `.nullable()` did not break the object form.
        expect(res.status).toBe(201);
      });

      it('seeds membership from deviceIds on a static create', async () => {
        vi.mocked(db.select).mockReset();
        vi.mocked(db.select)
          // validateManualMembershipDevices: device lookup
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                { id: DEVICE_ID, orgId: ORG_ID, siteId: null },
                { id: DEVICE_ID_2, orgId: ORG_ID, siteId: null }
              ])
            })
          } as any)
          // addManualGroupMemberships: existing-membership lookup
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) })
          } as any);

        const created = makeGroup({ type: 'static' });
        vi.mocked(db.insert).mockReturnValueOnce({
          values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([created]) })
        } as any);
        const membershipValuesMock = vi.fn().mockResolvedValue(undefined);
        vi.mocked(db.insert).mockReturnValueOnce({ values: membershipValuesMock } as any);

        const res = await app.request('/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ name: 'Static', type: 'static', deviceIds: [DEVICE_ID, DEVICE_ID_2] })
        });

        expect(res.status).toBe(201);
        expect(membershipValuesMock).toHaveBeenCalledTimes(1);
        const [membershipInsert] = membershipValuesMock.mock.calls;
        if (!membershipInsert) throw new Error('the membership insert was never called');
        const rows = membershipInsert[0] as Array<Record<string, unknown>>;
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row).toMatchObject({ groupId: GROUP_ID, orgId: ORG_ID, addedBy: 'manual' });
        }
        const body = await res.json();
        expect(body.data.deviceCount).toBe(2);

        // The membership write gets its own audit event, distinguishable from a
        // later manual add by `viaGroupCreate`.
        expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            action: 'device_group.device.add',
            orgId: ORG_ID,
            details: expect.objectContaining({
              addedCount: 2,
              deviceIds: [DEVICE_ID, DEVICE_ID_2],
              viaGroupCreate: true
            })
          })
        );
      });

      it('rejects deviceIds on a dynamic create', async () => {
        vi.mocked(db.select).mockReset();

        const res = await app.request('/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({
            name: 'Dynamic',
            type: 'dynamic',
            filterConditions: {
              operator: 'AND',
              conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }]
            },
            deviceIds: [DEVICE_ID]
          })
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain('dynamic group');
        expect(db.insert).not.toHaveBeenCalled();
      });

      it('rejects a cross-org device and creates no group', async () => {
        vi.mocked(db.select).mockReset();
        vi.mocked(db.select).mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: DEVICE_ID, orgId: ORG_ID_2, siteId: null }])
          })
        } as any);

        const res = await app.request('/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ name: 'Static', type: 'static', deviceIds: [DEVICE_ID] })
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.invalidDevices).toContain(DEVICE_ID);
        // No orphan empty group left behind on a rejected batch.
        expect(db.insert).not.toHaveBeenCalled();
      });

      it("rejects a device outside a site-bound group's site with 403 and creates no group", async () => {
        vi.mocked(db.select).mockReset();
        vi.mocked(db.select)
          // siteBelongsToOrg
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ id: SITE_ID }])
              })
            })
          } as any)
          // validateManualMembershipDevices: device lookup
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_ID_2 }])
            })
          } as any);

        const res = await app.request('/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({
            name: 'Static',
            type: 'static',
            siteId: SITE_ID,
            deviceIds: [DEVICE_ID]
          })
        });

        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error).toBe('Access to this site denied');
        expect(db.insert).not.toHaveBeenCalled();
      });

      it('does not query devices when deviceIds is an empty array', async () => {
        vi.mocked(db.select).mockReset();
        vi.mocked(db.insert).mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([makeGroup({ type: 'static' })])
          })
        } as any);

        const res = await app.request('/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ name: 'Static', type: 'static', deviceIds: [] })
        });

        // An empty list is not an error — it's what the dashboard sends for a
        // group with no devices selected — and it must not trigger a lookup.
        expect(res.status).toBe(201);
        expect(db.select).not.toHaveBeenCalled();
      });
    });
  });

});
