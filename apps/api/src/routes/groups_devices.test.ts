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

});
