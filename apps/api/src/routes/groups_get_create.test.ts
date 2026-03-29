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

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
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

vi.mock('../services/groupMembership', () => ({
  evaluateGroupMembership: vi.fn().mockResolvedValue(undefined),
  pinDeviceToGroup: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
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
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { validateFilter } from '../services/filterEngine';

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
  });

});
