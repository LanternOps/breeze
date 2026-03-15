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
  // GET / - List baselines
  // ----------------------------------------------------------------

  describe('GET /baselines', () => {
    it('should list baselines for the org', async () => {
      const baselines = [makeBaseline()];
      // count query
      vi.mocked(db.select)
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
                  offset: vi.fn().mockResolvedValue(baselines),
                }),
              }),
            }),
          }),
        } as any);

      const res = await app.request('/baselines', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.pagination.total).toBe(1);
    });

    it('should support pagination parameters', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 50 }]),
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

      const res = await app.request('/baselines?limit=10&offset=20', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pagination.limit).toBe(10);
      expect(body.pagination.offset).toBe(20);
      expect(body.pagination.total).toBe(50);
    });

    it('should reject invalid limit value', async () => {
      const res = await app.request('/baselines?limit=999', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------------
  // POST / - Create baseline
  // ----------------------------------------------------------------

  describe('POST /baselines', () => {
    it('should create a baseline', async () => {
      // site lookup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: SITE_ID }]),
          }),
        }),
      } as any);

      const created = makeBaseline();
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created]),
        }),
      } as any);

      const res = await app.request('/baselines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          siteId: SITE_ID,
          subnet: '192.168.1.0/24',
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe(BASELINE_ID);
      expect(body.subnet).toBe('192.168.1.0/24');
    });

    it('should return 400 when siteId is missing', async () => {
      const res = await app.request('/baselines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          subnet: '192.168.1.0/24',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('should return 400 for invalid subnet CIDR', async () => {
      const res = await app.request('/baselines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          siteId: SITE_ID,
          subnet: 'not-a-cidr',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('should return 404 when site not found for org', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request('/baselines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          siteId: SITE_ID,
          subnet: '10.0.0.0/24',
        }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('Site not found');
    });

    it('should return 409 on duplicate baseline', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: SITE_ID }]),
          }),
        }),
      } as any);

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockRejectedValue(
            Object.assign(new Error('unique constraint'), { code: '23505' })
          ),
        }),
      } as any);

      const res = await app.request('/baselines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          siteId: SITE_ID,
          subnet: '192.168.1.0/24',
        }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain('already exists');
    });

    it('should validate profileId against discovery profile', async () => {
      // site lookup
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: SITE_ID }]),
            }),
          }),
        } as any)
        // profile lookup
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        } as any);

      const res = await app.request('/baselines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          siteId: SITE_ID,
          subnet: '192.168.1.0/24',
          profileId: PROFILE_ID,
        }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('Discovery profile not found');
    });
  });

});
