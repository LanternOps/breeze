import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Site-axis enforcement on networkBaseline by-id paths (T9, #1051):
// GET /:id, PATCH /:id, POST /:id/scan, GET /:id/changes, DELETE /:id.
// Site scope is app-layer-only (RLS does NOT enforce it). GET / / POST /
// narrow by allowedSiteIds, but the by-id handlers historically did not, so a
// site-restricted org user could read/update/scan/delete baselines in other
// sites of the same org. Out-of-site → 404 (no oracle).

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BASELINE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

vi.mock('../services', () => ({}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/redis', () => ({ isRedisAvailable: vi.fn(() => true) }));
vi.mock('../jobs/networkBaselineWorker', () => ({
  enqueueBaselineScan: vi.fn().mockResolvedValue('job-123'),
}));
vi.mock('../services/networkBaseline', () => ({
  normalizeBaselineScanSchedule: vi.fn((s) => s ?? { enabled: false, intervalHours: 24 }),
  normalizeBaselineAlertSettings: vi.fn((s) => s ?? { newDevice: true, disappeared: true, changed: true, rogueDevice: true }),
}));

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  networkBaselines: {
    id: 'id', orgId: 'org_id', siteId: 'site_id', subnet: 'subnet', knownDevices: 'known_devices',
    scanSchedule: 'scan_schedule', alertSettings: 'alert_settings', lastScanAt: 'last_scan_at',
    lastScanJobId: 'last_scan_job_id', createdAt: 'created_at', updatedAt: 'updated_at',
  },
  networkChangeEvents: {
    id: 'id', orgId: 'org_id', siteId: 'site_id', baselineId: 'baseline_id', eventType: 'event_type',
    acknowledged: 'acknowledged', detectedAt: 'detected_at', createdAt: 'created_at', acknowledgedAt: 'acknowledged_at',
  },
  sites: { id: 'id', orgId: 'org_id' },
  discoveryProfiles: { id: 'id', orgId: 'org_id', siteId: 'site_id', subnets: 'subnets' },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization', orgId: ORG_ID, partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
      orgCondition: () => null,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    const restrict = c.req.header('x-restrict-site');
    c.set('permissions', restrict ? {
      permissions: [{ resource: 'devices', action: 'write' }],
      partnerId: null, orgId: ORG_ID, roleId: 'role-1', scope: 'organization',
      allowedSiteIds: restrict === '__empty__' ? [] : [restrict],
    } : undefined);
    return next();
  }),
}));

import { db } from '../db';
import { networkBaselineRoutes } from './networkBaselines';

function makeBaseline(overrides: Record<string, unknown> = {}) {
  return {
    id: BASELINE_ID, orgId: ORG_ID, siteId: SITE_A, subnet: '192.168.1.0/24',
    knownDevices: [], scanSchedule: { enabled: false, intervalHours: 24 },
    alertSettings: { newDevice: true, disappeared: true, changed: true, rogueDevice: true },
    lastScanAt: null, lastScanJobId: null,
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function selectOne(rows: any[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  } as any;
}

describe('networkBaseline by-id site-axis scope (T9, #1051)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(db.delete).mockReset();
    vi.mocked(db.transaction).mockReset();
    app = new Hono();
    app.route('/baselines', networkBaselineRoutes);
  });

  describe('GET /baselines/:id', () => {
    it('404 on an out-of-site baseline for a SITE_A-restricted caller', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectOne([makeBaseline({ siteId: SITE_B })]));
      const res = await app.request(`/baselines/${BASELINE_ID}`, { headers: { 'x-restrict-site': SITE_A } });
      expect(res.status).toBe(404);
    });

    it('200 on an in-site baseline for a SITE_A-restricted caller', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectOne([makeBaseline({ siteId: SITE_A })]));
      const res = await app.request(`/baselines/${BASELINE_ID}`, { headers: { 'x-restrict-site': SITE_A } });
      expect(res.status).toBe(200);
    });

    it('200 on an out-of-site baseline for an unrestricted caller (no regression)', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectOne([makeBaseline({ siteId: SITE_B })]));
      const res = await app.request(`/baselines/${BASELINE_ID}`);
      expect(res.status).toBe(200);
    });
  });

  describe('PATCH /baselines/:id', () => {
    it('404 and no write on an out-of-site baseline for a SITE_A-restricted caller', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectOne([makeBaseline({ siteId: SITE_B })]));
      const res = await app.request(`/baselines/${BASELINE_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-restrict-site': SITE_A },
        body: JSON.stringify({ alertSettings: { newDevice: false } }),
      });
      expect(res.status).toBe(404);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('updates an in-site baseline for a SITE_A-restricted caller', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectOne([makeBaseline({ siteId: SITE_A })]));
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([makeBaseline({ siteId: SITE_A })]),
          }),
        }),
      } as any);
      const res = await app.request(`/baselines/${BASELINE_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-restrict-site': SITE_A },
        body: JSON.stringify({ alertSettings: { newDevice: false } }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /baselines/:id/scan', () => {
    it('404 on an out-of-site baseline for a SITE_A-restricted caller', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectOne([makeBaseline({ siteId: SITE_B })]));
      const res = await app.request(`/baselines/${BASELINE_ID}/scan`, {
        method: 'POST',
        headers: { 'x-restrict-site': SITE_A },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /baselines/:id/changes', () => {
    it('404 on an out-of-site baseline for a SITE_A-restricted caller', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectOne([makeBaseline({ siteId: SITE_B })]));
      const res = await app.request(`/baselines/${BASELINE_ID}/changes`, { headers: { 'x-restrict-site': SITE_A } });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /baselines/:id', () => {
    it('404 and no delete on an out-of-site baseline for a SITE_A-restricted caller', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectOne([makeBaseline({ siteId: SITE_B })]));
      const res = await app.request(`/baselines/${BASELINE_ID}`, {
        method: 'DELETE',
        headers: { 'x-restrict-site': SITE_A },
      });
      expect(res.status).toBe(404);
      expect(db.delete).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });
});
