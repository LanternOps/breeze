import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

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
  // POST /remediate
  // ============================================
  describe('POST /cis/remediate', () => {
    it('creates remediation actions pending approval', async () => {
      // Device access
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
      // Latest baseline result
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: RESULT_ID,
                baselineId: BASELINE_ID,
                findings: [{ checkId: '1.1.1', status: 'fail' }],
              }]),
            }),
          }),
        }),
      } as any);
      vi.mocked(extractFailedCheckIds).mockReturnValueOnce(new Set(['1.1.1']));
      // Baseline lookup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: BASELINE_ID,
              orgId: ORG_ID,
              osType: 'windows',
            }]),
          }),
        }),
      } as any);
      // Insert remediation actions
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            { id: ACTION_ID, checkId: '1.1.1' },
          ]),
        }),
      } as any);

      const res = await app.request('/cis/remediate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          deviceId: DEVICE_ID,
          checkIds: ['1.1.1'],
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.actionIds).toHaveLength(1);
      expect(body.approvalStatus).toBe('pending');
    });

    it('returns 404 for nonexistent device', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request('/cis/remediate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          deviceId: DEVICE_ID,
          checkIds: ['1.1.1'],
        }),
      });

      expect(res.status).toBe(404);
    });

    it('returns 400 when checkIds are not failing', async () => {
      // Device access
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
      // Latest baseline result
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: RESULT_ID,
                baselineId: BASELINE_ID,
                findings: [{ checkId: '1.1.1', status: 'fail' }],
              }]),
            }),
          }),
        }),
      } as any);
      vi.mocked(extractFailedCheckIds).mockReturnValueOnce(new Set(['1.1.1']));
      // Baseline lookup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: BASELINE_ID,
              orgId: ORG_ID,
              osType: 'windows',
            }]),
          }),
        }),
      } as any);

      const res = await app.request('/cis/remediate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          deviceId: DEVICE_ID,
          checkIds: ['2.2.2'], // Not in the failing set
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.invalidCheckIds).toContain('2.2.2');
    });

    it('rejects empty checkIds array', async () => {
      const res = await app.request('/cis/remediate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          deviceId: DEVICE_ID,
          checkIds: [],
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ============================================
  // POST /remediate/approve
  // ============================================
  describe('POST /cis/remediate/approve', () => {
    it('approves pending remediation actions', async () => {
      // Lookup actions
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: ACTION_ID, orgId: ORG_ID, status: 'pending_approval', approvalStatus: 'pending' },
          ]),
        }),
      } as any);
      // Update approved
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);
      vi.mocked(scheduleCisRemediationWithResult).mockResolvedValueOnce({
        queuedActionIds: [ACTION_ID],
        failedActionIds: [],
      } as any);

      const res = await app.request('/cis/remediate/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          actionIds: [ACTION_ID],
          approved: true,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.approved).toBe(true);
      expect(body.queued).toBe(1);
    });

    it('rejects remediation actions', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: ACTION_ID, orgId: ORG_ID, status: 'pending_approval', approvalStatus: 'pending' },
          ]),
        }),
      } as any);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      const res = await app.request('/cis/remediate/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          actionIds: [ACTION_ID],
          approved: false,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.approved).toBe(false);
      expect(body.rejected).toBe(1);
    });

    it('returns 404 when actions not found', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const res = await app.request('/cis/remediate/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          actionIds: [ACTION_ID],
          approved: true,
        }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.missingIds).toContain(ACTION_ID);
    });

    it('returns 400 when no pending actions eligible', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: ACTION_ID, orgId: ORG_ID, status: 'completed', approvalStatus: 'approved' },
          ]),
        }),
      } as any);

      const res = await app.request('/cis/remediate/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          actionIds: [ACTION_ID],
          approved: true,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('No pending');
    });

    it('rejects empty actionIds', async () => {
      const res = await app.request('/cis/remediate/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          actionIds: [],
          approved: true,
        }),
      });

      expect(res.status).toBe(400);
    });
  });

});
