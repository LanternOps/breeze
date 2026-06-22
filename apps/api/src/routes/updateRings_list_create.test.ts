import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { updateRingRoutes } from './updateRings';

const RING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RING_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
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
  // GET / - List rings
  // ----------------------------------------------------------------
  describe('GET /update-rings', () => {
    it('should list rings for the partner', async () => {
      const rings = [
        makeRing({ name: 'Default', ringOrder: 0 }),
        makeRing({ id: RING_ID_2, name: 'Pilot', ringOrder: 1 })
      ];
      vi.mocked(db.select).mockReturnValueOnce({
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

    it('should list rings across multiple partners for system scope', async () => {
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

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([
              makeRing({ id: RING_ID, partnerId: PARTNER_ID, name: 'Pilot' }),
              makeRing({ id: RING_ID_2, partnerId: PARTNER_ID_2, name: 'Broad' })
            ])
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

    it('should return 403 for org-scope callers', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'org@example.com', name: 'Org User' },
          scope: 'organization',
          orgId: '11111111-1111-1111-1111-111111111111',
          partnerId: null,
          accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
          canAccessOrg: (id: string) => id === '11111111-1111-1111-1111-111111111111'
        });
        return next();
      });

      const res = await app.request('/update-rings', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
    });
  });

  // ----------------------------------------------------------------
  // POST / - Create ring
  // ----------------------------------------------------------------
  describe('POST /update-rings', () => {
    it('should create a new ring for the authenticated partner', async () => {
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

    it('should resolve partnerId from the query string for system users', async () => {
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

      const created = makeRing({ partnerId: PARTNER_ID });
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created])
        })
      } as any);

      const res = await app.request(`/update-rings?partnerId=${PARTNER_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Test Ring', deferralDays: 7, ringOrder: 1 })
      });

      expect(res.status).toBe(201);
    });

    it('should validate required fields (missing name)', async () => {
      const res = await app.request('/update-rings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(400);
    });

    it('should reject partner creating ring for a different partner', async () => {
      const res = await app.request('/update-rings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Ring',
          partnerId: PARTNER_ID_2
        })
      });

      expect(res.status).toBe(403);
    });

    it('should reject org-scope callers', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'org@example.com', name: 'Org User' },
          scope: 'organization',
          orgId: '11111111-1111-1111-1111-111111111111',
          partnerId: null,
          accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
          canAccessOrg: (id: string) => id === '11111111-1111-1111-1111-111111111111'
        });
        return next();
      });

      const res = await app.request('/update-rings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Ring' })
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

    // #1317: ring now owns the typed auto-approve gate.
    it('should accept a typed autoApprove gate', async () => {
      const autoApprove = { enabled: true, severities: ['critical', 'important'], deferralDays: 7 };
      const created = makeRing({ autoApprove });
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created])
        })
      } as any);

      const res = await app.request('/update-rings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Ring', autoApprove })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.autoApprove).toEqual(autoApprove);
    });

    it('should reject autoApprove enabled with no severities (fail-closed)', async () => {
      const res = await app.request('/update-rings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Ring',
          autoApprove: { enabled: true, severities: [], deferralDays: 0 }
        })
      });

      expect(res.status).toBe(400);
    });

    it('should reject autoApprove deferralDays out of range', async () => {
      const res = await app.request('/update-rings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Ring',
          autoApprove: { enabled: true, severities: ['critical'], deferralDays: 9999 }
        })
      });

      expect(res.status).toBe(400);
    });
  });

});
