import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { updateRingRoutes } from './updateRings';

const RING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RING_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID_2 = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const PATCH_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
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
  patchPolicies: {
    id: 'id',
    orgId: 'orgId',
    name: 'name',
    description: 'description',
    enabled: 'enabled',
    ringOrder: 'ringOrder',
    deferralDays: 'deferralDays',
    deadlineDays: 'deadlineDays',
    gracePeriodHours: 'gracePeriodHours',
    categories: 'categories',
    excludeCategories: 'excludeCategories',
    sources: 'sources',
    autoApprove: 'autoApprove',
    categoryRules: 'categoryRules',
    targets: 'targets',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    createdBy: 'createdBy'
  },
  patchApprovals: {
    orgId: 'orgId',
    ringId: 'ringId',
    patchId: 'patchId',
    status: 'status'
  },
  patchJobs: {
    id: 'id',
    name: 'name',
    ringId: 'ringId',
    status: 'status',
    devicesTotal: 'devicesTotal',
    devicesCompleted: 'devicesCompleted',
    devicesFailed: 'devicesFailed',
    createdAt: 'createdAt'
  },
  patchComplianceSnapshots: {},
  patches: {
    id: 'id',
    title: 'title',
    description: 'description',
    source: 'source',
    severity: 'severity',
    category: 'category',
    osTypes: 'osTypes',
    releaseDate: 'releaseDate',
    requiresReboot: 'requiresReboot',
    downloadSizeMb: 'downloadSizeMb',
    createdAt: 'createdAt'
  },
  devicePatches: {
    deviceId: 'deviceId',
    patchId: 'patchId',
    status: 'status'
  },
  devices: {
    id: 'id',
    orgId: 'orgId'
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

function makeRing(overrides: Record<string, unknown> = {}) {
  return {
    id: RING_ID,
    orgId: ORG_ID,
    name: 'Test Ring',
    description: 'A test update ring',
    enabled: true,
    ringOrder: 1,
    deferralDays: 7,
    deadlineDays: 14,
    gracePeriodHours: 4,
    categories: [],
    excludeCategories: [],
    sources: null,
    autoApprove: {},
    categoryRules: [],
    targets: {},
    createdBy: 'user-123',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides
  };
}

describe('updateRings routes', () => {
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
    app.route('/update-rings', updateRingRoutes);
  });

  // ----------------------------------------------------------------
  // GET / - List rings
  // ----------------------------------------------------------------
  describe('GET /update-rings', () => {
    it('should list rings for the org', async () => {
      const rings = [
        makeRing({ name: 'Default', ringOrder: 0 }),
        makeRing({ id: RING_ID_2, name: 'Pilot', ringOrder: 1 })
      ];
      // ensureDefaultRing - check existing
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: RING_ID }])
            })
          })
        } as any)
        // list query
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(rings)
            })
          })
        } as any);

      const res = await app.request('/update-rings', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
    });

    it('should auto-create default ring if none exists', async () => {
      // ensureDefaultRing - no existing
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);
      // insert default ring
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: RING_ID }])
        })
      } as any);
      // list query
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([makeRing({ name: 'Default', ringOrder: 0 })])
          })
        })
      } as any);

      const res = await app.request('/update-rings', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      expect(vi.mocked(db.insert)).toHaveBeenCalled();
    });

    it('should handle partner with no accessible orgs needing orgId', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'partner@example.com', name: 'Partner' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID, ORG_ID_2],
          canAccessOrg: () => true
        });
        return next();
      });

      const res = await app.request('/update-rings', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------------
  // POST / - Create ring
  // ----------------------------------------------------------------
  describe('POST /update-rings', () => {
    it('should create a new ring', async () => {
      const created = makeRing();
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created])
        })
      } as any);

      const res = await app.request('/update-rings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Test Ring',
          deferralDays: 7,
          ringOrder: 1
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('Test Ring');
    });

    it('should validate required fields (missing name)', async () => {
      const res = await app.request('/update-rings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(400);
    });

    it('should reject access to inaccessible org', async () => {
      const res = await app.request('/update-rings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Ring',
          orgId: ORG_ID_2
        })
      });

      expect(res.status).toBe(403);
    });

    it('should validate deferralDays range', async () => {
      const res = await app.request('/update-rings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Ring',
          deferralDays: 999
        })
      });

      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------------
  // GET /:id - Ring detail
  // ----------------------------------------------------------------
  describe('GET /update-rings/:id', () => {
    it('should return ring detail with compliance summary', async () => {
      vi.mocked(db.select)
        // ring lookup
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeRing()])
            })
          })
        } as any)
        // approval counts
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([
                { status: 'approved', count: 5 },
                { status: 'pending', count: 2 }
              ])
            })
          })
        } as any)
        // recent jobs
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([])
              })
            })
          })
        } as any);

      const res = await app.request(`/update-rings/${RING_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(RING_ID);
      expect(body.approvalSummary).toBeDefined();
      expect(body.recentJobs).toBeDefined();
    });

    it('should return 404 for non-existent ring', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/update-rings/${RING_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });

    it('should return 403 for ring from inaccessible org', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeRing({ orgId: ORG_ID_2 })])
          })
        })
      } as any);

      const res = await app.request(`/update-rings/${RING_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
    });

    it('should reject invalid UUID param', async () => {
      const res = await app.request('/update-rings/not-a-uuid', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------------
  // PATCH /:id - Update ring
  // ----------------------------------------------------------------
  describe('PATCH /update-rings/:id', () => {
    it('should update a ring', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: RING_ID, orgId: ORG_ID }])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([makeRing({ name: 'Updated Ring' })])
          })
        })
      } as any);

      const res = await app.request(`/update-rings/${RING_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Updated Ring' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Updated Ring');
    });

    it('should return 404 for non-existent ring', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/update-rings/${RING_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Updated' })
      });

      expect(res.status).toBe(404);
    });

    it('should return 403 for ring from inaccessible org', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: RING_ID, orgId: ORG_ID_2 }])
          })
        })
      } as any);

      const res = await app.request(`/update-rings/${RING_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Hack' })
      });

      expect(res.status).toBe(403);
    });
  });

  // ----------------------------------------------------------------
  // DELETE /:id - Soft delete ring
  // ----------------------------------------------------------------
  describe('DELETE /update-rings/:id', () => {
    it('should soft-delete (disable) a ring', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: RING_ID, orgId: ORG_ID, name: 'Test Ring' }])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const res = await app.request(`/update-rings/${RING_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('should return 404 for non-existent ring', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/update-rings/${RING_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });

    it('should return 403 for ring from inaccessible org', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: RING_ID, orgId: ORG_ID_2, name: 'Ring' }])
          })
        })
      } as any);

      const res = await app.request(`/update-rings/${RING_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
    });
  });

  // ----------------------------------------------------------------
  // GET /:id/patches - Ring-scoped patches
  // ----------------------------------------------------------------
  describe('GET /update-rings/:id/patches', () => {
    it('should list patches with approval status for a ring', async () => {
      vi.mocked(db.select)
        // ring lookup
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: RING_ID, orgId: ORG_ID }])
            })
          })
        } as any)
        // patches list
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([
                    {
                      id: PATCH_ID,
                      title: 'Security Update',
                      description: 'Important fix',
                      source: 'microsoft',
                      severity: 'critical',
                      category: 'Security',
                      osTypes: ['windows'],
                      releaseDate: new Date('2026-01-01'),
                      requiresReboot: true,
                      downloadSizeMb: 50,
                      createdAt: new Date('2026-01-01')
                    }
                  ])
                })
              })
            })
          })
        } as any)
        // count
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any)
        // approval statuses
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { patchId: PATCH_ID, status: 'approved' }
            ])
          })
        } as any);

      const res = await app.request(`/update-rings/${RING_ID}/patches`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].approvalStatus).toBe('approved');
      expect(body.pagination).toBeDefined();
    });

    it('should return 404 for non-existent ring', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/update-rings/${RING_ID}/patches`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });
  });

  // ----------------------------------------------------------------
  // GET /:id/compliance - Ring compliance
  // ----------------------------------------------------------------
  describe('GET /update-rings/:id/compliance', () => {
    it('should return compliance data for a ring', async () => {
      vi.mocked(db.select)
        // ring lookup
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: RING_ID, orgId: ORG_ID, name: 'Test Ring' }])
            })
          })
        } as any)
        // org devices
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: 'device-1' }, { id: 'device-2' }])
          })
        } as any)
        // approved patches
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ patchId: PATCH_ID }])
          })
        } as any)
        // device patch status
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([
                { status: 'installed', count: 1 },
                { status: 'pending', count: 1 }
              ])
            })
          })
        } as any);

      const res = await app.request(`/update-rings/${RING_ID}/compliance`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.ringId).toBe(RING_ID);
      expect(body.data.summary).toBeDefined();
      expect(body.data.compliancePercent).toBeDefined();
    });

    it('should return 100% compliance when no devices', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: RING_ID, orgId: ORG_ID, name: 'Test Ring' }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([])
          })
        } as any);

      const res = await app.request(`/update-rings/${RING_ID}/compliance`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.compliancePercent).toBe(100);
    });

    it('should return 404 for non-existent ring', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/update-rings/${RING_ID}/compliance`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });
  });

  // ----------------------------------------------------------------
  // Partner/System scope tests
  // ----------------------------------------------------------------
  describe('partner scope', () => {
    beforeEach(() => {
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
    });

    it('should auto-resolve orgId for single-org partner', async () => {
      // ensureDefaultRing
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: RING_ID }])
          })
        })
      } as any);
      // list query
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([makeRing()])
          })
        })
      } as any);

      const res = await app.request('/update-rings', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
    });

    it('should reject partner creating ring for inaccessible org', async () => {
      const res = await app.request('/update-rings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Ring', orgId: ORG_ID_2 })
      });

      expect(res.status).toBe(403);
    });
  });

  describe('system scope', () => {
    beforeEach(() => {
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
    });

    it('should require orgId for system scope list', async () => {
      const res = await app.request('/update-rings', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
    });
  });
});
