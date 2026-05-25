import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Site-scope enforcement on CIS hardening device routes.
 *
 * These tests verify that `assertDeviceAccess` (the file-local chokepoint
 * in `cisHardening.ts`) honors `permissions.allowedSiteIds`. Before Task 12
 * of the launch-readiness fixes, the helper only checked `auth.orgCondition`
 * — partner-scope users restricted to a subset of sites within an org could
 * call `GET /devices/:deviceId/report`, `POST /remediate`, and `POST /scan`
 * against devices in sites outside their allowlist.
 *
 * The mocks below mirror the pattern in
 * `apps/api/src/routes/devices/core.permissions.test.ts` — the
 * `requirePermission` middleware populates `permissions` in the Hono
 * context, and `x-restrict-site` opts a request into a single-site
 * allowlist for that scope.
 */

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  cisBaselines: {
    id: 'cisBaselines.id',
    orgId: 'cisBaselines.orgId',
    osType: 'cisBaselines.osType',
    isActive: 'cisBaselines.isActive',
    updatedAt: 'cisBaselines.updatedAt',
  },
  cisBaselineResults: {
    id: 'cisBaselineResults.id',
    orgId: 'cisBaselineResults.orgId',
    deviceId: 'cisBaselineResults.deviceId',
    baselineId: 'cisBaselineResults.baselineId',
    checkedAt: 'cisBaselineResults.checkedAt',
    totalChecks: 'cisBaselineResults.totalChecks',
    passedChecks: 'cisBaselineResults.passedChecks',
    failedChecks: 'cisBaselineResults.failedChecks',
    score: 'cisBaselineResults.score',
    findings: 'cisBaselineResults.findings',
    summary: 'cisBaselineResults.summary',
    createdAt: 'cisBaselineResults.createdAt',
  },
  cisRemediationActions: {
    id: 'cisRemediationActions.id',
    orgId: 'cisRemediationActions.orgId',
    deviceId: 'cisRemediationActions.deviceId',
    baselineId: 'cisRemediationActions.baselineId',
    baselineResultId: 'cisRemediationActions.baselineResultId',
    checkId: 'cisRemediationActions.checkId',
    status: 'cisRemediationActions.status',
    approvalStatus: 'cisRemediationActions.approvalStatus',
    createdAt: 'cisRemediationActions.createdAt',
    executedAt: 'cisRemediationActions.executedAt',
    approvedAt: 'cisRemediationActions.approvedAt',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    osType: 'devices.osType',
    hostname: 'devices.hostname',
    siteId: 'devices.siteId',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-111',
      accessibleOrgIds: ['org-111'],
      orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === 'org-111',
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    const allowedSiteIds = c.req.header('x-restrict-site')
      ? [c.req.header('x-restrict-site') as string]
      : undefined;
    c.set('permissions', {
      permissions: [{ resource: 'devices', action: 'read' }],
      partnerId: null,
      orgId: 'org-111',
      roleId: 'role-1',
      scope: 'organization',
      ...(allowedSiteIds ? { allowedSiteIds } : {}),
    });
    return next();
  }),
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/cisHardening', () => ({
  extractFailedCheckIds: vi.fn(() => new Set(['1.1.1'])),
  normalizeCisSchedule: vi.fn((s: any) => s ?? null),
}));
vi.mock('../jobs/cisJobs', () => ({
  scheduleCisScan: vi.fn().mockResolvedValue('job-1'),
  scheduleCisRemediation: vi.fn(),
  scheduleCisRemediationWithResult: vi.fn(),
}));
vi.mock('./networkShared', () => ({
  resolveOrgId: vi.fn((auth: any) => ({ orgId: auth.orgId })),
}));

import { cisHardeningRoutes } from './cisHardening';
import { db } from '../db';

const ORG_ID = 'org-111';
const DEVICE_ID = '22222222-2222-2222-2222-222222222222';
const BASELINE_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_SITE_ID = 'site-a';
const FORBIDDEN_SITE_ID = 'site-b';

function rigDeviceLookup(device: unknown) {
  // assertDeviceAccess issues `db.select(...).from(devices).where(...).limit(1)`.
  const limit = vi.fn().mockResolvedValue(device ? [device] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValueOnce({ from } as never);
}

describe('CIS hardening — site-scope enforcement', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/cis', cisHardeningRoutes);
  });

  describe('GET /cis/devices/:deviceId/report', () => {
    it('returns 403 when caller is site-restricted away from the device site', async () => {
      rigDeviceLookup({
        id: DEVICE_ID,
        orgId: ORG_ID,
        osType: 'windows',
        hostname: 'host-1',
        siteId: DEVICE_SITE_ID,
      });
      const res = await app.request(`/cis/devices/${DEVICE_ID}/report`, {
        method: 'GET',
        headers: { Authorization: 'Bearer t', 'x-restrict-site': FORBIDDEN_SITE_ID },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/site/i);
    });

    it('returns 404 when device is not found (org-scope denial)', async () => {
      rigDeviceLookup(null);
      const res = await app.request(`/cis/devices/${DEVICE_ID}/report`, {
        method: 'GET',
        headers: { Authorization: 'Bearer t' },
      });
      expect(res.status).toBe(404);
    });

    it('allows the request through when caller is restricted to the device site', async () => {
      // Device access lookup
      rigDeviceLookup({
        id: DEVICE_ID,
        orgId: ORG_ID,
        osType: 'windows',
        hostname: 'host-1',
        siteId: DEVICE_SITE_ID,
      });
      // Reports query
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
      } as never);
      const res = await app.request(`/cis/devices/${DEVICE_ID}/report`, {
        method: 'GET',
        headers: { Authorization: 'Bearer t', 'x-restrict-site': DEVICE_SITE_ID },
      });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /cis/remediate', () => {
    it('returns 403 when caller is site-restricted away from the device site', async () => {
      rigDeviceLookup({
        id: DEVICE_ID,
        orgId: ORG_ID,
        osType: 'windows',
        hostname: 'host-1',
        siteId: DEVICE_SITE_ID,
      });
      const res = await app.request('/cis/remediate', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer t',
          'Content-Type': 'application/json',
          'x-restrict-site': FORBIDDEN_SITE_ID,
        },
        body: JSON.stringify({
          deviceId: DEVICE_ID,
          checkIds: ['1.1.1'],
        }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /cis/scan', () => {
    it('returns 403 when at least one targeted device is outside the site allowlist', async () => {
      // Baseline lookup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: BASELINE_ID,
              orgId: ORG_ID,
              osType: 'windows',
              isActive: true,
            }]),
          }),
        }),
      } as never);
      // Scoped device lookup — returns devices in DENIED site
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: DEVICE_ID, siteId: FORBIDDEN_SITE_ID },
          ]),
        }),
      } as never);

      const res = await app.request('/cis/scan', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer t',
          'Content-Type': 'application/json',
          'x-restrict-site': DEVICE_SITE_ID,
        },
        body: JSON.stringify({
          baselineId: BASELINE_ID,
          deviceIds: [DEVICE_ID],
        }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/site/i);
      expect(body.deniedDeviceIds).toEqual([DEVICE_ID]);
    });

    it('allows the scan when all targeted devices are within the site allowlist', async () => {
      // Baseline lookup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: BASELINE_ID,
              orgId: ORG_ID,
              osType: 'windows',
              isActive: true,
            }]),
          }),
        }),
      } as never);
      // Scoped device lookup — devices are in the ALLOWED site
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: DEVICE_ID, siteId: DEVICE_SITE_ID },
          ]),
        }),
      } as never);

      const res = await app.request('/cis/scan', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer t',
          'Content-Type': 'application/json',
          'x-restrict-site': DEVICE_SITE_ID,
        },
        body: JSON.stringify({
          baselineId: BASELINE_ID,
          deviceIds: [DEVICE_ID],
        }),
      });
      expect(res.status).toBe(202);
    });
  });
});
