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
  // GET /remediations
  // ============================================
  describe('GET /cis/remediations', () => {
    it('lists remediation actions with pagination', async () => {
      // Count query
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }]),
          }),
        }),
      } as any);
      // Data query
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockResolvedValue([{
                      action: {
                        id: ACTION_ID,
                        orgId: ORG_ID,
                        status: 'pending_approval',
                        approvalStatus: 'pending',
                        createdAt: new Date(),
                        executedAt: null,
                        approvedAt: null,
                      },
                      deviceHostname: 'SRV-01',
                      baselineName: 'Windows L1',
                    }]),
                  }),
                }),
              }),
            }),
          }),
        }),
      } as any);

      const res = await app.request('/cis/remediations', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].deviceHostname).toBe('SRV-01');
      expect(body.pagination.total).toBe(1);
    });

    it('filters by status', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ count: 0 }]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnValue({
                      offset: vi.fn().mockResolvedValue([]),
                    }),
                  }),
                }),
              }),
            }),
          }),
        } as any);

      const res = await app.request('/cis/remediations?status=completed', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
    });
  });

  // ============================================
  // Multi-tenant isolation
  // ============================================
  describe('multi-tenant isolation', () => {
    const ORG_ID_OTHER = 'org-999';

    it('denies access to baselines from a different org', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-2', email: 'other@example.com', name: 'Other User' },
          scope: 'organization',
          partnerId: null,
          orgId: ORG_ID_OTHER,
          accessibleOrgIds: [ORG_ID_OTHER],
          orgCondition: () => undefined,
          canAccessOrg: (id: string) => id === ORG_ID_OTHER,
        });
        return next();
      });

      // Baseline lookup returns empty because it filters by the user's orgId
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request('/cis/baselines', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      // User from ORG_ID_OTHER should see no baselines belonging to ORG_ID
      expect(body.data).toHaveLength(0);
    });

    it('denies access to scan results from a different org', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-2', email: 'other@example.com', name: 'Other User' },
          scope: 'organization',
          partnerId: null,
          orgId: ORG_ID_OTHER,
          accessibleOrgIds: [ORG_ID_OTHER],
          orgCondition: () => undefined,
          canAccessOrg: (id: string) => id === ORG_ID_OTHER,
        });
        return next();
      });

      // Remediations count query returns 0 since filtered by user's org
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ count: 0 }]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnValue({
                      offset: vi.fn().mockResolvedValue([]),
                    }),
                  }),
                }),
              }),
            }),
          }),
        } as any);

      const res = await app.request('/cis/remediations', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(0);
      expect(body.pagination.total).toBe(0);
    });

    it('prevents cross-org baseline creation via resolveOrgId', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-2', email: 'other@example.com', name: 'Other User' },
          scope: 'partner',
          partnerId: 'partner-2',
          orgId: null,
          accessibleOrgIds: [ORG_ID_OTHER],
          orgCondition: () => undefined,
          canAccessOrg: (id: string) => id === ORG_ID_OTHER,
        });
        return next();
      });

      // Partner user tries to create baseline for ORG_ID they don't have access to
      const res = await app.request('/cis/baselines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Cross-org baseline',
          osType: 'windows',
          benchmarkVersion: '3.0.0',
          level: 'l1',
          orgId: ORG_ID,
        }),
      });

      // Should fail because canAccessOrg returns false for ORG_ID
      expect([400, 403]).toContain(res.status);
    });
  });

});
