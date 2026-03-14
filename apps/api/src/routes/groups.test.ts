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
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID
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
  // GET / - List groups
  // ----------------------------------------------------------------
  describe('GET /groups', () => {
    it('should list groups for the org', async () => {
      const groups = [makeGroup(), makeGroup({ id: GROUP_ID_2, name: 'Second Group' })];
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(groups)
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([
                { groupId: GROUP_ID, count: 3 },
                { groupId: GROUP_ID_2, count: 1 }
              ])
            })
          })
        } as any);

      const res = await app.request('/groups', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it('should filter groups by type', async () => {
      const groups = [makeGroup({ type: 'dynamic' })];
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(groups)
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([])
            })
          })
        } as any);

      const res = await app.request('/groups?type=dynamic', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    it('should filter groups by search term', async () => {
      const groups = [
        makeGroup({ name: 'Production Servers' }),
        makeGroup({ id: GROUP_ID_2, name: 'Dev Machines' })
      ];
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(groups)
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([])
            })
          })
        } as any);

      const res = await app.request('/groups?search=prod', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe('Production Servers');
    });

    it('should return empty for org user with no orgId', async () => {
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
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });
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

  // ----------------------------------------------------------------
  // PATCH /:id - Update group
  // ----------------------------------------------------------------
  describe('PATCH /groups/:id', () => {
    it('should update a group name', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeGroup()])
            })
          })
        } as any);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([makeGroup({ name: 'Updated Name' })])
          })
        })
      } as any);
      // getDeviceCountForGroup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 2 }])
        })
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Updated Name' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe('Updated Name');
    });

    it('should return 404 for non-existent group', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Updated' })
      });

      expect(res.status).toBe(404);
    });

    it('should reject self-referential parentId', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeGroup()])
          })
        })
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ parentId: GROUP_ID })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('its own parent');
    });

    it('should return 404 when user cannot edit group from different org', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeGroup({ orgId: ORG_ID_2 })])
          })
        })
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Hack' })
      });

      expect(res.status).toBe(404);
    });
  });

  // ----------------------------------------------------------------
  // DELETE /:id - Delete group
  // ----------------------------------------------------------------
  describe('DELETE /groups/:id', () => {
    it('should delete a group', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeGroup()])
            })
          })
        } as any)
        // Check for child groups
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }])
          })
        } as any);

      vi.mocked(db.delete)
        .mockReturnValueOnce({ where: vi.fn().mockResolvedValue(undefined) } as any)
        .mockReturnValueOnce({ where: vi.fn().mockResolvedValue(undefined) } as any);

      const res = await app.request(`/groups/${GROUP_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(GROUP_ID);
    });

    it('should return 404 when deleting non-existent group', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });

    it('should reject deleting group with child groups', async () => {
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
            where: vi.fn().mockResolvedValue([{ count: 2 }])
          })
        } as any);

      const res = await app.request(`/groups/${GROUP_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('child groups');
    });

    it('should reject deleting group from another org (multi-tenant isolation)', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeGroup({ orgId: ORG_ID_2 })])
          })
        })
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });
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
  // POST /:id/preview - Preview dynamic group
  // ----------------------------------------------------------------
  describe('POST /groups/:id/preview', () => {
    it('should preview devices matching dynamic group filter', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeGroup({
              type: 'dynamic',
              filterConditions: {
                operator: 'AND',
                conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }]
              }
            })])
          })
        })
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}/preview`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.totalCount).toBe(1);
      expect(body.data.devices).toHaveLength(1);
    });

    it('should reject preview for static group', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeGroup({ type: 'static' })])
          })
        })
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}/preview`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('dynamic groups');
    });

    it('should reject preview when no filter conditions', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeGroup({ type: 'dynamic', filterConditions: null })])
          })
        })
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}/preview`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('no filter conditions');
    });
  });

  // ----------------------------------------------------------------
  // POST /:id/devices/:deviceId/pin - Pin device
  // ----------------------------------------------------------------
  describe('POST /groups/:id/devices/:deviceId/pin', () => {
    it('should pin a device in a dynamic group', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeGroup({ type: 'dynamic' })])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: DEVICE_ID, orgId: ORG_ID }])
            })
          })
        } as any);

      const res = await app.request(`/groups/${GROUP_ID}/devices/${DEVICE_ID}/pin`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.isPinned).toBe(true);
    });

    it('should reject pinning in a static group', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeGroup({ type: 'static' })])
          })
        })
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}/devices/${DEVICE_ID}/pin`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('dynamic groups');
    });

    it('should return 404 for device from different org', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeGroup({ type: 'dynamic' })])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: DEVICE_ID, orgId: ORG_ID_2 }])
            })
          })
        } as any);

      const res = await app.request(`/groups/${GROUP_ID}/devices/${DEVICE_ID}/pin`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });
  });

  // ----------------------------------------------------------------
  // DELETE /:id/devices/:deviceId/pin - Unpin device
  // ----------------------------------------------------------------
  describe('DELETE /groups/:id/devices/:deviceId/pin', () => {
    it('should unpin a device from a dynamic group', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeGroup({ type: 'dynamic' })])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ deviceId: DEVICE_ID, isPinned: true }])
            })
          })
        } as any);

      const res = await app.request(`/groups/${GROUP_ID}/devices/${DEVICE_ID}/pin`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.isPinned).toBe(false);
    });

    it('should reject unpinning in a static group', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeGroup({ type: 'static' })])
          })
        })
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}/devices/${DEVICE_ID}/pin`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
    });

    it('should return 404 when device is not a member', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeGroup({ type: 'dynamic' })])
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

      const res = await app.request(`/groups/${GROUP_ID}/devices/${DEVICE_ID}/pin`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });

    it('should reject unpinning device that is not pinned', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeGroup({ type: 'dynamic' })])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ deviceId: DEVICE_ID, isPinned: false }])
            })
          })
        } as any);

      const res = await app.request(`/groups/${GROUP_ID}/devices/${DEVICE_ID}/pin`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('not pinned');
    });
  });

  // ----------------------------------------------------------------
  // GET /:id/membership-log
  // ----------------------------------------------------------------
  describe('GET /groups/:id/membership-log', () => {
    it('should return membership log for a group', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeGroup()])
            })
          })
        } as any)
        // count query
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any)
        // log entries query
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockResolvedValue([
                      {
                        id: 'log-1',
                        groupId: GROUP_ID,
                        deviceId: DEVICE_ID,
                        action: 'added',
                        reason: 'manual',
                        createdAt: new Date('2026-01-01'),
                        hostname: 'host-1',
                        displayName: 'Host One'
                      }
                    ])
                  })
                })
              })
            })
          })
        } as any);

      const res = await app.request(`/groups/${GROUP_ID}/membership-log`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
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

      const res = await app.request(`/groups/${GROUP_ID}/membership-log`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });
  });

  // ----------------------------------------------------------------
  // Partner scope tests
  // ----------------------------------------------------------------
  describe('partner scope access', () => {
    beforeEach(() => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'partner@example.com', name: 'Partner User' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID],
          canAccessOrg: (orgId: string) => orgId === ORG_ID
        });
        return next();
      });
    });

    it('should list groups for accessible orgs', async () => {
      const groups = [makeGroup()];
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(groups)
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([])
            })
          })
        } as any);

      const res = await app.request('/groups', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    it('should auto-resolve orgId for single-org partner on create', async () => {
      const created = makeGroup();
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created])
        })
      } as any);

      const res = await app.request('/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Partner Group' })
      });

      expect(res.status).toBe(201);
    });
  });
});
