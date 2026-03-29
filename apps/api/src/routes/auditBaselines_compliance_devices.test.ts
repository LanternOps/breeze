import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ── Mocks ──────────────────────────────────────────────────────────

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
  auditBaselines: {
    id: 'auditBaselines.id',
    orgId: 'auditBaselines.orgId',
    name: 'auditBaselines.name',
    osType: 'auditBaselines.osType',
    profile: 'auditBaselines.profile',
    settings: 'auditBaselines.settings',
    isActive: 'auditBaselines.isActive',
    createdBy: 'auditBaselines.createdBy',
    createdAt: 'auditBaselines.createdAt',
    updatedAt: 'auditBaselines.updatedAt',
  },
  auditBaselineApplyApprovals: {
    id: 'auditBaselineApplyApprovals.id',
    orgId: 'auditBaselineApplyApprovals.orgId',
    baselineId: 'auditBaselineApplyApprovals.baselineId',
    requestedBy: 'auditBaselineApplyApprovals.requestedBy',
    status: 'auditBaselineApplyApprovals.status',
    requestPayload: 'auditBaselineApplyApprovals.requestPayload',
    expiresAt: 'auditBaselineApplyApprovals.expiresAt',
    approvedBy: 'auditBaselineApplyApprovals.approvedBy',
    approvedAt: 'auditBaselineApplyApprovals.approvedAt',
    consumedAt: 'auditBaselineApplyApprovals.consumedAt',
    createdAt: 'auditBaselineApplyApprovals.createdAt',
    updatedAt: 'auditBaselineApplyApprovals.updatedAt',
  },
  auditBaselineResults: {
    orgId: 'auditBaselineResults.orgId',
    deviceId: 'auditBaselineResults.deviceId',
    baselineId: 'auditBaselineResults.baselineId',
    compliant: 'auditBaselineResults.compliant',
    score: 'auditBaselineResults.score',
    deviations: 'auditBaselineResults.deviations',
    checkedAt: 'auditBaselineResults.checkedAt',
    remediatedAt: 'auditBaselineResults.remediatedAt',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    hostname: 'devices.hostname',
    osType: 'devices.osType',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../services/commandQueue', () => ({
  CommandTypes: { APPLY_AUDIT_POLICY_BASELINE: 'apply_audit_policy_baseline' },
  queueCommandForExecution: vi.fn(),
}));

vi.mock('../services/auditBaselineService', () => ({
  getTemplateSettings: vi.fn().mockReturnValue({ 'auditpol:AccountLogon': 'Success and Failure' }),
}));

vi.mock('../jobs/auditBaselineJobs', () => ({
  enqueueAuditDriftEvaluation: vi.fn(),
}));

vi.mock('./networkShared', () => ({
  resolveOrgId: vi.fn(),
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { auditBaselineRoutes } from './auditBaselines';
import { resolveOrgId } from './networkShared';
import { queueCommandForExecution } from '../services/commandQueue';

// ── Constants ──────────────────────────────────────────────────────

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID_2 = '22222222-2222-2222-2222-222222222222';
const BASELINE_ID = '33333333-3333-3333-3333-333333333333';
const DEVICE_ID = '44444444-4444-4444-4444-444444444444';
const APPROVAL_ID = '55555555-5555-5555-5555-555555555555';

const NOW = new Date('2026-03-13T12:00:00Z');

function setAuth(overrides: Record<string, unknown> = {}) {
  vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (id: string) => id === ORG_ID,
      orgCondition: () => undefined,
      ...overrides,
    });
    return next();
  });
}

function makeApp() {
  const app = new Hono();
  app.route('/baselines', auditBaselineRoutes);
  return app;
}

// ── Tests ──────────────────────────────────────────────────────────


describe('auditBaselines routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    app = makeApp();
  });

  // ────────────────────── GET /compliance ──────────────────────
  describe('GET /compliance', () => {
    it('returns compliance summary', async () => {
      vi.mocked(resolveOrgId).mockReturnValue({ orgId: ORG_ID } as any);
      const rows = [
        {
          result: {
            deviceId: DEVICE_ID,
            baselineId: BASELINE_ID,
            compliant: true,
            score: 90,
            checkedAt: NOW,
          },
          baselineName: 'CIS L1',
          baselineOsType: 'windows',
        },
        {
          result: {
            deviceId: '66666666-6666-6666-6666-666666666666',
            baselineId: BASELINE_ID,
            compliant: false,
            score: 50,
            checkedAt: NOW,
          },
          baselineName: 'CIS L1',
          baselineOsType: 'windows',
        },
      ];

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(rows),
            }),
          }),
        }),
      } as any);

      const res = await app.request('/baselines/compliance');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalDevices).toBe(2);
      expect(body.compliant).toBe(1);
      expect(body.nonCompliant).toBe(1);
      expect(body.averageScore).toBe(70);
      expect(body.baselines).toHaveLength(1);
    });

    it('returns empty compliance when no results', async () => {
      vi.mocked(resolveOrgId).mockReturnValue({ orgId: ORG_ID } as any);
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      } as any);

      const res = await app.request('/baselines/compliance');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalDevices).toBe(0);
      expect(body.averageScore).toBe(0);
    });
  });

  // ────────────────────── GET /devices/:deviceId ──────────────────────
  describe('GET /devices/:deviceId', () => {
    it('returns 200 with device baseline results', async () => {
      // First query: find the device
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: DEVICE_ID, orgId: ORG_ID, hostname: 'PC-01' }]),
          }),
        }),
      } as any);
      // Second query: get results
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([
                {
                  result: {
                    baselineId: BASELINE_ID,
                    compliant: true,
                    score: 95,
                    deviations: [],
                    checkedAt: NOW,
                    remediatedAt: null,
                  },
                  baselineName: 'CIS L1',
                  baselineOsType: 'windows',
                },
              ]),
            }),
          }),
        }),
      } as any);

      const res = await app.request(`/baselines/devices/${DEVICE_ID}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.device.id).toBe(DEVICE_ID);
      expect(body.baselines).toHaveLength(1);
      expect(body.baselines[0].score).toBe(95);
    });

    it('returns 404 when device is not found', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/baselines/devices/${DEVICE_ID}`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Device not found');
    });
  });

});
