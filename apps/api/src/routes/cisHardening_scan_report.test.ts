import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
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
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../services/cisHardening', () => ({
  extractFailedCheckIds: vi.fn(),
  normalizeCisSchedule: vi.fn((s: any) => s ?? null),
}));

vi.mock('../jobs/cisJobs', () => ({
  scheduleCisScan: vi.fn(),
  scheduleCisRemediation: vi.fn(),
  scheduleCisRemediationWithResult: vi.fn(),
}));

vi.mock('./networkShared', () => ({
  resolveOrgId: vi.fn((auth: any, requestedOrgId?: string) => {
    if (auth.scope === 'organization') {
      return { orgId: auth.orgId };
    }
    if (requestedOrgId) return { orgId: requestedOrgId };
    return { error: 'orgId is required', status: 400 };
  }),
}));

import { cisHardeningRoutes } from './cisHardening';
import { db } from '../db';
import { scheduleCisScan, scheduleCisRemediationWithResult } from '../jobs/cisJobs';
import { extractFailedCheckIds } from '../services/cisHardening';

const ORG_ID = 'org-111';
const BASELINE_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '22222222-2222-2222-2222-222222222222';
const RESULT_ID = '33333333-3333-3333-3333-333333333333';
const ACTION_ID = '44444444-4444-4444-4444-444444444444';

function makeBaseline(overrides: Record<string, any> = {}) {
  return {
    id: BASELINE_ID,
    orgId: ORG_ID,
    name: 'Windows L1',
    osType: 'windows',
    benchmarkVersion: '3.0.0',
    level: 'l1',
    customExclusions: [],
    scanSchedule: null,
    isActive: true,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}


describe('CIS hardening routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/cis', cisHardeningRoutes);
  });

  // ============================================
  // POST /scan
  // ============================================
  describe('POST /cis/scan', () => {
    it('triggers a scan for a baseline', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeBaseline()]),
          }),
        }),
      } as any);
      vi.mocked(scheduleCisScan).mockResolvedValueOnce('job-123');

      const res = await app.request('/cis/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ baselineId: BASELINE_ID }),
      });

      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.message).toContain('CIS scan queued');
      expect(body.jobId).toBe('job-123');
      expect(scheduleCisScan).toHaveBeenCalledTimes(1);
    });

    it('returns 404 for nonexistent baseline', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request('/cis/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ baselineId: BASELINE_ID }),
      });

      expect(res.status).toBe(404);
    });

    it('returns 400 for inactive baseline', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeBaseline({ isActive: false })]),
          }),
        }),
      } as any);

      const res = await app.request('/cis/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ baselineId: BASELINE_ID }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('inactive');
    });

    it('validates deviceIds belong to baseline org and os scope', async () => {
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
            where: vi.fn().mockResolvedValue([]), // No matching devices
          }),
        } as any);

      const res = await app.request('/cis/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          baselineId: BASELINE_ID,
          deviceIds: [DEVICE_ID],
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('do not belong');
    });
  });

  // ============================================
  // GET /devices/:deviceId/report
  // ============================================
  describe('GET /cis/devices/:deviceId/report', () => {
    it('returns device CIS report', async () => {
      // Device access check
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: DEVICE_ID,
              orgId: ORG_ID,
              osType: 'windows',
              hostname: 'SRV-01',
            }]),
          }),
        }),
      } as any);
      // Results query
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    result: {
                      id: RESULT_ID,
                      orgId: ORG_ID,
                      deviceId: DEVICE_ID,
                      baselineId: BASELINE_ID,
                      checkedAt: new Date(),
                      totalChecks: 50,
                      passedChecks: 45,
                      failedChecks: 5,
                      score: 90,
                      findings: [],
                      summary: {},
                      createdAt: new Date(),
                    },
                    baseline: makeBaseline(),
                  },
                ]),
              }),
            }),
          }),
        }),
      } as any);

      const res = await app.request(`/cis/devices/${DEVICE_ID}/report`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.device.id).toBe(DEVICE_ID);
      expect(body.reports).toHaveLength(1);
      expect(body.reports[0].result.score).toBe(90);
    });

    it('returns 404 for nonexistent device', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/cis/devices/${DEVICE_ID}/report`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
    });
  });

});
