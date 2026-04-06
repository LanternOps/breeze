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
  // GET /baselines
  // ============================================
  describe('GET /cis/baselines', () => {
    it('lists baselines with pagination', async () => {
      // Count query
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        }),
      } as any);
      // Data query
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([makeBaseline()]),
              }),
            }),
          }),
        }),
      } as any);

      const res = await app.request('/cis/baselines', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe('Windows L1');
      expect(body.pagination).toBeDefined();
      expect(body.pagination.total).toBe(1);
    });

    it('filters by osType', async () => {
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

      const res = await app.request('/cis/baselines?osType=linux', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(0);
    });
  });

  // ============================================
  // POST /baselines
  // ============================================
  describe('POST /cis/baselines', () => {
    it('creates a new baseline', async () => {
      const created = makeBaseline();
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created]),
        }),
      } as any);

      const res = await app.request('/cis/baselines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Windows L1',
          osType: 'windows',
          benchmarkVersion: '3.0.0',
          level: 'l1',
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.name).toBe('Windows L1');
    });

    it('updates existing baseline when id is provided', async () => {
      // Existing lookup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeBaseline()]),
          }),
        }),
      } as any);
      // Update
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([makeBaseline({ name: 'Updated Name' })]),
          }),
        }),
      } as any);

      const res = await app.request('/cis/baselines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          id: BASELINE_ID,
          name: 'Updated Name',
          osType: 'windows',
          benchmarkVersion: '3.0.0',
          level: 'l1',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe('Updated Name');
    });

    it('returns 404 when updating nonexistent baseline', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request('/cis/baselines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          id: BASELINE_ID,
          name: 'Updated Name',
          osType: 'windows',
          benchmarkVersion: '3.0.0',
          level: 'l1',
        }),
      });

      expect(res.status).toBe(404);
    });

    it('rejects invalid osType', async () => {
      const res = await app.request('/cis/baselines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Test',
          osType: 'freebsd',
          benchmarkVersion: '1.0',
          level: 'l1',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects invalid level', async () => {
      const res = await app.request('/cis/baselines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Test',
          osType: 'windows',
          benchmarkVersion: '1.0',
          level: 'l3',
        }),
      });

      expect(res.status).toBe(400);
    });
  });

});
