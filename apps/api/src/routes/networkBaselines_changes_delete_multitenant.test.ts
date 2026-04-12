import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID_2 = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BASELINE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROFILE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../services/redis', () => ({
  isRedisAvailable: vi.fn(() => true),
}));

vi.mock('../jobs/networkBaselineWorker', () => ({
  enqueueBaselineScan: vi.fn().mockResolvedValue('job-123'),
}));

vi.mock('../services/networkBaseline', () => ({
  normalizeBaselineScanSchedule: vi.fn((s) => s ?? { enabled: false, intervalHours: 24 }),
  normalizeBaselineAlertSettings: vi.fn((s) => s ?? { newDevice: true, disappeared: true, changed: true, rogueDevice: true }),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  networkBaselines: {
    id: 'id',
    orgId: 'org_id',
    siteId: 'site_id',
    subnet: 'subnet',
    knownDevices: 'known_devices',
    scanSchedule: 'scan_schedule',
    alertSettings: 'alert_settings',
    lastScanAt: 'last_scan_at',
    lastScanJobId: 'last_scan_job_id',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  networkChangeEvents: {
    id: 'id',
    orgId: 'org_id',
    siteId: 'site_id',
    baselineId: 'baseline_id',
    eventType: 'event_type',
    acknowledged: 'acknowledged',
    detectedAt: 'detected_at',
    createdAt: 'created_at',
    acknowledgedAt: 'acknowledged_at',
  },
  sites: {
    id: 'id',
    orgId: 'org_id',
  },
  discoveryProfiles: {
    id: 'id',
    orgId: 'org_id',
    siteId: 'site_id',
    subnets: 'subnets',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      partnerId: null,
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111',
      orgCondition: () => null,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { isRedisAvailable } from '../services/redis';
import { networkBaselineRoutes } from './networkBaselines';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseline(overrides: Record<string, unknown> = {}) {
  return {
    id: BASELINE_ID,
    orgId: ORG_ID,
    siteId: SITE_ID,
    subnet: '192.168.1.0/24',
    knownDevices: [],
    scanSchedule: { enabled: false, intervalHours: 24 },
    alertSettings: { newDevice: true, disappeared: true, changed: true, rogueDevice: true },
    lastScanAt: null,
    lastScanJobId: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function makeChangeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    orgId: ORG_ID,
    siteId: SITE_ID,
    baselineId: BASELINE_ID,
    profileId: null,
    eventType: 'new_device',
    ipAddress: '192.168.1.50',
    macAddress: 'aa:bb:cc:dd:ee:ff',
    hostname: 'new-host',
    vendor: null,
    deviceData: null,
    previousData: null,
    acknowledged: false,
    acknowledgedBy: null,
    acknowledgedAt: null,
    notes: null,
    alertId: null,
    linkedDeviceId: null,
    detectedAt: new Date('2026-03-01'),
    createdAt: new Date('2026-03-01'),
    ...overrides,
  };
}

function mockSelectChain(result: any) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            offset: vi.fn().mockResolvedValue(result),
          }),
        }),
      }),
    }),
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------


describe('networkBaseline routes', () => {
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
        canAccessOrg: (orgId: string) => orgId === ORG_ID,
        orgCondition: () => null,
      });
      return next();
    });
    app = new Hono();
    app.route('/baselines', networkBaselineRoutes);
  });

  // ----------------------------------------------------------------
  // GET /:id/changes - List changes for baseline
  // ----------------------------------------------------------------

  describe('GET /baselines/:id/changes', () => {
    it('should list change events for a baseline', async () => {
      // getBaselineWithAccess
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeBaseline()]),
            }),
          }),
        } as any)
        // count query
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }]),
          }),
        } as any)
        // data query
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([makeChangeEvent()]),
                }),
              }),
            }),
          }),
        } as any);

      const res = await app.request(`/baselines/${BASELINE_ID}/changes`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.pagination.total).toBe(1);
    });

    it('should filter by eventType', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([makeBaseline()]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        } as any);

      const res = await app.request(`/baselines/${BASELINE_ID}/changes?eventType=rogue_device`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
    });

    it('should reject invalid eventType', async () => {
      // zValidator rejects before getBaselineWithAccess runs — no db mock needed
      const res = await app.request(`/baselines/${BASELINE_ID}/changes?eventType=invalid_type`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------------
  // DELETE /:id - Delete baseline
  // ----------------------------------------------------------------

  describe('DELETE /baselines/:id', () => {
    it('should delete a baseline with associated changes', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeBaseline()]),
          }),
        }),
      } as any);

      vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
        const tx = {
          delete: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        };
        return fn(tx);
      });

      const res = await app.request(`/baselines/${BASELINE_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.deletedChanges).toBe(true);
    });

    it('should delete without changes when deleteChanges=false', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeBaseline()]),
          }),
        }),
      } as any);

      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockResolvedValue(undefined),
      } as any);

      const res = await app.request(`/baselines/${BASELINE_ID}?deleteChanges=false`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deletedChanges).toBe(false);
    });

    it('should return 404 when baseline not found', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/baselines/${BASELINE_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
    });

    it('should return 409 when FK constraint prevents deletion without change cascade', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeBaseline()]),
          }),
        }),
      } as any);

      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockRejectedValue(
          Object.assign(new Error('FK violation'), { code: '23503' })
        ),
      } as any);

      const res = await app.request(`/baselines/${BASELINE_ID}?deleteChanges=false`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain('Cannot delete baseline');
      expect(body.hint).toContain('deleteChanges=true');
    });
  });

  // ----------------------------------------------------------------
  // Multi-tenant isolation
  // ----------------------------------------------------------------

  describe('multi-tenant isolation', () => {
    it('should deny org user accessing another org baselines', async () => {
      const res = await app.request(`/baselines?orgId=${ORG_ID_2}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      // resolveOrgId will return 403 for org-scope user accessing different org
      expect(res.status).toBe(403);
    });

    it('should deny create in different org', async () => {
      const res = await app.request('/baselines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          orgId: ORG_ID_2,
          siteId: SITE_ID,
          subnet: '10.0.0.0/24',
        }),
      });

      expect(res.status).toBe(403);
    });
  });

  // ----------------------------------------------------------------
  // Partner scope
  // ----------------------------------------------------------------

  describe('partner scope', () => {
    beforeEach(() => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-456', email: 'partner@test.com', name: 'Partner' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID],
          canAccessOrg: (orgId: string) => orgId === ORG_ID,
          orgCondition: () => null,
        });
        return next();
      });
    });

    it('should allow partner to list baselines for accessible org', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        } as any);

      const res = await app.request(`/baselines?orgId=${ORG_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
    });

    it('should deny partner access to inaccessible org', async () => {
      const res = await app.request(`/baselines?orgId=${ORG_ID_2}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
    });
  });

});
