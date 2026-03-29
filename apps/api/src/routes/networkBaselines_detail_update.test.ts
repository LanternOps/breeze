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
  // GET /:id - Get single baseline
  // ----------------------------------------------------------------

  describe('GET /baselines/:id', () => {
    it('should return a baseline by ID', async () => {
      const baseline = makeBaseline();
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([baseline]),
          }),
        }),
      } as any);

      const res = await app.request(`/baselines/${BASELINE_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(BASELINE_ID);
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
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
    });
  });

  // ----------------------------------------------------------------
  // PATCH /:id - Update baseline
  // ----------------------------------------------------------------

  describe('PATCH /baselines/:id', () => {
    it('should update scanSchedule', async () => {
      const baseline = makeBaseline();
      // getBaselineWithAccess
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([baseline]),
          }),
        }),
      } as any);

      const updated = makeBaseline({ scanSchedule: { enabled: true, intervalHours: 12 } });
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      } as any);

      const res = await app.request(`/baselines/${BASELINE_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ scanSchedule: { enabled: true, intervalHours: 12 } }),
      });

      expect(res.status).toBe(200);
    });

    it('should return 400 when neither scanSchedule nor alertSettings provided', async () => {
      const res = await app.request(`/baselines/${BASELINE_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
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
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ alertSettings: { newDevice: false } }),
      });

      expect(res.status).toBe(404);
    });
  });

  // ----------------------------------------------------------------
  // POST /:id/scan - Trigger scan
  // ----------------------------------------------------------------

  describe('POST /baselines/:id/scan', () => {
    it('should trigger a baseline scan', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeBaseline()]),
          }),
        }),
      } as any);

      const res = await app.request(`/baselines/${BASELINE_ID}/scan`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.baselineId).toBe(BASELINE_ID);
      expect(body.queueJobId).toBe('job-123');
    });

    it('should return 404 when baseline not found', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/baselines/${BASELINE_ID}/scan`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
    });

    it('should return 503 when Redis is unavailable', async () => {
      vi.mocked(isRedisAvailable).mockReturnValue(false);

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeBaseline()]),
          }),
        }),
      } as any);

      const res = await app.request(`/baselines/${BASELINE_ID}/scan`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toContain('Redis');
    });
  });

});
