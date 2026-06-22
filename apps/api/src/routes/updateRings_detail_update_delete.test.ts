import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { updateRingRoutes } from './updateRings';

const RING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const PARTNER_ID_2 = '44444444-4444-4444-4444-444444444444';

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('./updateRingsHelpers', () => ({
  resolveRingDeviceCounts: vi.fn().mockResolvedValue(new Map()),
  resolveRingDeviceIds: vi.fn().mockResolvedValue([])
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

    it('should return 403 for ring from a different partner', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeRing({ partnerId: PARTNER_ID_2 })])
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
            limit: vi.fn().mockResolvedValue([{ id: RING_ID, partnerId: PARTNER_ID }])
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

    it('should return 403 for ring from a different partner', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: RING_ID, partnerId: PARTNER_ID_2 }])
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

    // #1317: ring update accepts the typed auto-approve gate.
    it('should update a ring autoApprove gate', async () => {
      const autoApprove = { enabled: true, severities: ['critical'], deferralDays: 3 };
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: RING_ID, partnerId: PARTNER_ID }])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([makeRing({ autoApprove })])
          })
        })
      } as any);

      const res = await app.request(`/update-rings/${RING_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ autoApprove })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.autoApprove).toEqual(autoApprove);
    });

    it('should reject a PATCH autoApprove enabled with no severities', async () => {
      const res = await app.request(`/update-rings/${RING_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ autoApprove: { enabled: true, severities: [], deferralDays: 0 } })
      });

      expect(res.status).toBe(400);
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
            limit: vi.fn().mockResolvedValue([{ id: RING_ID, partnerId: PARTNER_ID, name: 'Test Ring' }])
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

    it('should return 403 for ring from a different partner', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: RING_ID, partnerId: PARTNER_ID_2, name: 'Ring' }])
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

});
