import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { updateRingRoutes } from './updateRings';

const RING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const PARTNER_ID_2 = '44444444-4444-4444-4444-444444444444';
const PATCH_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('./updateRingsHelpers', () => ({
  resolveRingDeviceCounts: vi.fn().mockResolvedValue(new Map()),
  resolveRingDeviceIds: vi.fn().mockResolvedValue([]),
}));

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
  patchPolicies: {
    id: 'id',
    partnerId: 'partnerId',
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
    createdBy: 'createdBy',
    kind: 'kind',
  },
  patchApprovals: {
    partnerId: 'partnerId',
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
      user: { id: 'user-123', email: 'partner@example.com', name: 'Partner User' },
      scope: 'partner',
      orgId: null,
      partnerId: PARTNER_ID,
      accessibleOrgIds: [],
      canAccessOrg: () => false
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { resolveRingDeviceIds } from './updateRingsHelpers';

function makeRing(overrides: Record<string, unknown> = {}) {
  return {
    id: RING_ID,
    partnerId: PARTNER_ID,
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
    vi.mocked(resolveRingDeviceIds).mockResolvedValue([]);
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'partner@example.com', name: 'Partner User' },
        scope: 'partner',
        orgId: null,
        partnerId: PARTNER_ID,
        accessibleOrgIds: [],
        canAccessOrg: () => false
      });
      return next();
    });
    app = new Hono();
    app.route('/update-rings', updateRingRoutes);
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
              limit: vi.fn().mockResolvedValue([{ id: RING_ID, partnerId: PARTNER_ID }])
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
        // per-source counts (#2215)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([
                { source: 'microsoft', count: 1 }
              ])
            })
          })
        } as any)
        // approval statuses (partner-scoped)
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
      // Ring endpoint must return the same shape as GET /patches (#2215):
      // a derived scalar `os` per patch and a per-source `counts` aggregate.
      expect(body.data[0].os).toBe('windows');
      expect(body.counts).toEqual({
        microsoft: 1,
        apple: 0,
        linux: 0,
        third_party: 0,
        custom: 0,
      });
      expect(body.pagination).toBeDefined();
    });

    it('derives os from source when osTypes is empty (#2215)', async () => {
      vi.mocked(db.select)
        // ring lookup
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: RING_ID, partnerId: PARTNER_ID }])
            })
          })
        } as any)
        // patches list — no osTypes, no device-derived hint → source fallback
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([
                    {
                      id: PATCH_ID,
                      title: 'macOS Sequoia Update',
                      source: 'apple',
                      severity: 'important',
                      osTypes: [],
                      inferredOs: null,
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
        // per-source counts
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([{ source: 'apple', count: 1 }])
            })
          })
        } as any)
        // approval statuses
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([])
          })
        } as any);

      const res = await app.request(`/update-rings/${RING_ID}/patches`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data[0].os).toBe('macos');
      expect(body.counts.apple).toBe(1);
    });

    // Pagination regression (#1316 follow-up): the ring endpoint must share the
    // /patches getPagination — default 50, capped at 200 (not the old local 100).
    // Selecting a ring previously collapsed the visible list because the web sent
    // no `limit` and this endpoint defaulted to 50. The web now sends ?limit=200.
    function mockRingPatchesQuery() {
      const limitSpy = vi.fn().mockReturnValue({
        offset: vi.fn().mockResolvedValue([]) // empty page → skips approval lookup
      });
      vi.mocked(db.select)
        // ring lookup
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: RING_ID, partnerId: PARTNER_ID }])
            })
          })
        } as any)
        // patches list
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({ limit: limitSpy })
            })
          })
        } as any)
        // count
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }])
          })
        } as any)
        // per-source counts (#2215)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([])
            })
          })
        } as any);
      return limitSpy;
    }

    it('honors an explicit ?limit=200 (matches the web ring fetch)', async () => {
      const limitSpy = mockRingPatchesQuery();

      const res = await app.request(`/update-rings/${RING_ID}/patches?limit=200`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      expect(limitSpy).toHaveBeenCalledWith(200);
      const body = await res.json();
      expect(body.pagination.limit).toBe(200);
    });

    it('caps ?limit at the shared 200, not the old local 100', async () => {
      const limitSpy = mockRingPatchesQuery();

      const res = await app.request(`/update-rings/${RING_ID}/patches?limit=500`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      expect(limitSpy).toHaveBeenCalledWith(200);
      const body = await res.json();
      expect(body.pagination.limit).toBe(200);
    });

    it('defaults to a 50-row page when no ?limit is given', async () => {
      const limitSpy = mockRingPatchesQuery();

      const res = await app.request(`/update-rings/${RING_ID}/patches`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      expect(limitSpy).toHaveBeenCalledWith(50);
      const body = await res.json();
      expect(body.pagination.limit).toBe(50);
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

    it('should return 403 for ring from a different partner', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: RING_ID, partnerId: PARTNER_ID_2 }])
          })
        })
      } as any);

      const res = await app.request(`/update-rings/${RING_ID}/patches`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
    });
  });

  // ----------------------------------------------------------------
  // GET /:id/compliance - Ring compliance
  // ----------------------------------------------------------------
  describe('GET /update-rings/:id/compliance', () => {
    it('should return compliance data for a ring with assigned devices', async () => {
      // Ring has devices assigned via config-policy assignments
      vi.mocked(resolveRingDeviceIds).mockResolvedValueOnce(['device-1', 'device-2']);

      vi.mocked(db.select)
        // ring lookup
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: RING_ID, partnerId: PARTNER_ID, name: 'Test Ring' }])
            })
          })
        } as any)
        // approved patches (partner-scoped)
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
      // Confirm device resolution used the helper, not a direct org-scoped query
      expect(vi.mocked(resolveRingDeviceIds)).toHaveBeenCalledWith(RING_ID);
    });

    it('should return 100% compliance when no devices assigned to ring', async () => {
      // resolveRingDeviceIds returns [] by default in beforeEach
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: RING_ID, partnerId: PARTNER_ID, name: 'Test Ring' }])
          })
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

    it('should return 403 for ring from a different partner', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: RING_ID, partnerId: PARTNER_ID_2, name: 'Other Ring' }])
          })
        })
      } as any);

      const res = await app.request(`/update-rings/${RING_ID}/compliance`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
    });
  });

  // ----------------------------------------------------------------
  // Partner/System scope tests
  // ----------------------------------------------------------------
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

    it('should list rings without partnerId for system scope', async () => {
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
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    it('should allow system scope to access any ring', async () => {
      // Ring belongs to a different partner, but system can see it
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeRing({ partnerId: PARTNER_ID_2 })])
            })
          })
        } as any)
        // approval counts
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([])
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
    });
  });

});
