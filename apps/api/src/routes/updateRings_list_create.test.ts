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

vi.mock('./updateRingsHelpers', () => ({
  resolveRingDeviceCounts: vi.fn().mockResolvedValue(new Map())
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
      orgId: '11111111-1111-1111-1111-111111111111',
      partnerId: null,
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111'
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

});
