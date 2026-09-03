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
      partnerOrgAccess: 'all',
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
        partnerOrgAccess: 'all',
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

    it('no longer returns sources in ring detail responses', async () => {
      vi.mocked(db.select)
        // ring lookup — the sources column was dropped (#3151), so a real
        // full-row select never returns it and neither must the response.
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
      const body = await res.json();
      expect(body).not.toHaveProperty('sources');
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

    it('PATCH persists thirdPartyApps and thirdPartyDeferralDays', async () => {
      const autoApprove = {
        enabled: true,
        severities: [] as string[],
        deferralDays: 0,
        thirdPartyApps: true,
        thirdPartyDeferralDays: 21
      };
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: RING_ID, partnerId: PARTNER_ID }])
          })
        })
      } as any);
      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([makeRing({ autoApprove })])
        })
      });
      vi.mocked(db.update).mockReturnValueOnce({ set: setMock } as any);

      const res = await app.request(`/update-rings/${RING_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ autoApprove })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.autoApprove).toEqual(autoApprove);

      const updateFields = setMock.mock.calls[0]![0] as Record<string, unknown>;
      expect(updateFields.autoApprove).toMatchObject({
        thirdPartyApps: true,
        thirdPartyDeferralDays: 21
      });
    });

    it('accepts autoApproveUnrated on the default rule and persists it in auto_approve', async () => {
      const autoApprove = {
        enabled: true,
        severities: ['critical'] as string[],
        deferralDays: 0,
        autoApproveUnrated: true
      };
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: RING_ID, partnerId: PARTNER_ID }])
          })
        })
      } as any);
      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([makeRing({ autoApprove })])
        })
      });
      vi.mocked(db.update).mockReturnValueOnce({ set: setMock } as any);

      const res = await app.request(`/update-rings/${RING_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ autoApprove })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.autoApprove.autoApproveUnrated).toBe(true);

      const updateFields = setMock.mock.calls[0]![0] as Record<string, unknown>;
      expect(updateFields.autoApprove).toMatchObject({ autoApproveUnrated: true });
    });

    it('PATCH with an old-shape autoApprove preserves the stored third-party opt-in (merge, not replace)', async () => {
      // A pre-2026-08 client replays {enabled, severities, deferralDays} — the
      // absent third-party fields must carry the stored row's values instead
      // of resetting a toggle the client doesn't know about.
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: RING_ID,
              partnerId: PARTNER_ID,
              autoApprove: { enabled: true, severities: ['critical'], deferralDays: 0, thirdPartyApps: true, thirdPartyDeferralDays: 9 }
            }])
          })
        })
      } as any);
      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([makeRing()])
        })
      });
      vi.mocked(db.update).mockReturnValueOnce({ set: setMock } as any);

      const res = await app.request(`/update-rings/${RING_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ autoApprove: { enabled: true, severities: ['important'], deferralDays: 5 } })
      });

      expect(res.status).toBe(200);
      const updateFields = setMock.mock.calls[0]![0] as Record<string, unknown>;
      expect(updateFields.autoApprove).toEqual({
        enabled: true,
        severities: ['important'],
        deferralDays: 5,
        thirdPartyApps: true,
        thirdPartyDeferralDays: 9,
        autoApproveUnrated: false
      });
    });

    it('PATCH derives the preserved third-party opt-in from a legacy stored row without the field', async () => {
      // Stored pre-backfill severity ring: absent thirdPartyApps derives true
      // (the old #2218 exemption), so an old-shape write keeps 3P on.
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: RING_ID,
              partnerId: PARTNER_ID,
              autoApprove: { enabled: true, severities: ['critical'] }
            }])
          })
        })
      } as any);
      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([makeRing()])
        })
      });
      vi.mocked(db.update).mockReturnValueOnce({ set: setMock } as any);

      const res = await app.request(`/update-rings/${RING_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ autoApprove: { enabled: true, severities: ['critical'], deferralDays: 3 } })
      });

      expect(res.status).toBe(200);
      const updateFields = setMock.mock.calls[0]![0] as Record<string, unknown>;
      expect(updateFields.autoApprove).toMatchObject({ thirdPartyApps: true, thirdPartyDeferralDays: null });
    });

    it('PATCH with an explicit thirdPartyApps:false overrides the stored opt-in', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: RING_ID,
              partnerId: PARTNER_ID,
              autoApprove: { enabled: true, severities: ['critical'], deferralDays: 0, thirdPartyApps: true, thirdPartyDeferralDays: 9 }
            }])
          })
        })
      } as any);
      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([makeRing()])
        })
      });
      vi.mocked(db.update).mockReturnValueOnce({ set: setMock } as any);

      const res = await app.request(`/update-rings/${RING_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ autoApprove: { enabled: true, severities: ['critical'], deferralDays: 0, thirdPartyApps: false, thirdPartyDeferralDays: null } })
      });

      expect(res.status).toBe(200);
      const updateFields = setMock.mock.calls[0]![0] as Record<string, unknown>;
      expect(updateFields.autoApprove).toMatchObject({ thirdPartyApps: false, thirdPartyDeferralDays: null });
    });

    it('PATCH silently strips a sources payload (unknown key) — the DB update never sees it', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: RING_ID, partnerId: PARTNER_ID }])
          })
        })
      } as any);
      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([makeRing()])
        })
      });
      vi.mocked(db.update).mockReturnValueOnce({ set: setMock } as any);

      const res = await app.request(`/update-rings/${RING_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        // Zod strips unknown keys by default, so `sources` is silently dropped
        // rather than rejected — assert the DB update call never sees it.
        body: JSON.stringify({ sources: ['third_party'] })
      });

      expect(res.status).toBe(200);
      const updateFields = setMock.mock.calls[0]![0] as Record<string, unknown>;
      expect(updateFields).not.toHaveProperty('sources');
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
