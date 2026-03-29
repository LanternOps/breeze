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

  // ────────────────────── POST /apply-requests ──────────────────────
  describe('POST /apply-requests', () => {
    it('creates an apply request for eligible devices', async () => {
      vi.mocked(resolveOrgId).mockReturnValue({ orgId: ORG_ID } as any);
      // Find baseline
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: BASELINE_ID,
              orgId: ORG_ID,
              osType: 'windows',
              profile: 'cis_l1',
              settings: {},
              isActive: true,
            }]),
          }),
        }),
      } as any);
      // Find target devices
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: DEVICE_ID, osType: 'windows', hostname: 'PC-01' },
          ]),
        }),
      } as any);
      // Insert approval
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: APPROVAL_ID,
            orgId: ORG_ID,
            baselineId: BASELINE_ID,
            requestedBy: 'user-1',
            status: 'pending',
            requestPayload: { baselineId: BASELINE_ID, deviceIds: [DEVICE_ID] },
            expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
            approvedAt: null,
            consumedAt: null,
            createdAt: NOW,
            updatedAt: NOW,
          }]),
        }),
      } as any);

      const res = await app.request('/baselines/apply-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baselineId: BASELINE_ID,
          deviceIds: [DEVICE_ID],
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.approval.id).toBe(APPROVAL_ID);
      expect(body.eligibleDeviceIds).toContain(DEVICE_ID);
    });

    it('returns 404 when baseline is not found', async () => {
      vi.mocked(resolveOrgId).mockReturnValue({ orgId: ORG_ID } as any);
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request('/baselines/apply-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baselineId: BASELINE_ID,
          deviceIds: [DEVICE_ID],
        }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Baseline not found');
    });

    it('returns 400 for non-Windows baselines', async () => {
      vi.mocked(resolveOrgId).mockReturnValue({ orgId: ORG_ID } as any);
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: BASELINE_ID,
              orgId: ORG_ID,
              osType: 'linux',
              profile: 'cis_l1',
            }]),
          }),
        }),
      } as any);

      const res = await app.request('/baselines/apply-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baselineId: BASELINE_ID,
          deviceIds: [DEVICE_ID],
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Windows only');
    });

    it('returns 400 when no devices are eligible due to OS mismatch', async () => {
      vi.mocked(resolveOrgId).mockReturnValue({ orgId: ORG_ID } as any);
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
      // Devices are all macOS
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: DEVICE_ID, osType: 'macos', hostname: 'MAC-01' },
          ]),
        }),
      } as any);

      const res = await app.request('/baselines/apply-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baselineId: BASELINE_ID,
          deviceIds: [DEVICE_ID],
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('No target devices are eligible');
    });
  });

  // ────────────────────── POST /apply-requests/:approvalId/decision ──────────────────────
  describe('POST /apply-requests/:approvalId/decision', () => {
    it('approves a pending request from a different user', async () => {
      vi.mocked(resolveOrgId).mockReturnValue({ orgId: ORG_ID } as any);
      const futureDate = new Date('2099-01-01T00:00:00Z');
      // Approval request was created by a different user
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: APPROVAL_ID,
              orgId: ORG_ID,
              baselineId: BASELINE_ID,
              requestedBy: 'user-2',
              status: 'pending',
              expiresAt: futureDate,
              approvedAt: null,
              consumedAt: null,
              createdAt: NOW,
              updatedAt: NOW,
            }]),
          }),
        }),
      } as any);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: APPROVAL_ID,
              orgId: ORG_ID,
              baselineId: BASELINE_ID,
              status: 'approved',
              approvedBy: 'user-1',
              approvedAt: NOW,
              consumedAt: null,
              expiresAt: futureDate,
              createdAt: NOW,
              updatedAt: NOW,
            }]),
          }),
        }),
      } as any);

      const res = await app.request(`/baselines/apply-requests/${APPROVAL_ID}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.approval.status).toBe('approved');
    });

    it('rejects self-approval', async () => {
      vi.mocked(resolveOrgId).mockReturnValue({ orgId: ORG_ID } as any);
      const futureDate = new Date('2099-01-01T00:00:00Z');
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: APPROVAL_ID,
              orgId: ORG_ID,
              requestedBy: 'user-1', // same as current user
              status: 'pending',
              expiresAt: futureDate,
            }]),
          }),
        }),
      } as any);

      const res = await app.request(`/baselines/apply-requests/${APPROVAL_ID}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('cannot approve their own');
    });

    it('returns 409 for non-pending request', async () => {
      vi.mocked(resolveOrgId).mockReturnValue({ orgId: ORG_ID } as any);
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: APPROVAL_ID,
              orgId: ORG_ID,
              requestedBy: 'user-2',
              status: 'approved',
              expiresAt: new Date(NOW.getTime() + 3600000),
            }]),
          }),
        }),
      } as any);

      const res = await app.request(`/baselines/apply-requests/${APPROVAL_ID}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain('already approved');
    });

    it('returns 404 when approval not found', async () => {
      vi.mocked(resolveOrgId).mockReturnValue({ orgId: ORG_ID } as any);
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/baselines/apply-requests/${APPROVAL_ID}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'rejected' }),
      });

      expect(res.status).toBe(404);
    });
  });

  // ────────────────────── GET /apply-requests ──────────────────────
  describe('GET /apply-requests', () => {
    it('lists apply requests', async () => {
      vi.mocked(resolveOrgId).mockReturnValue({ orgId: ORG_ID } as any);
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([
                {
                  approval: {
                    id: APPROVAL_ID,
                    orgId: ORG_ID,
                    baselineId: BASELINE_ID,
                    requestedBy: 'user-1',
                    status: 'pending',
                    expiresAt: new Date(NOW.getTime() + 3600000),
                    approvedAt: null,
                    consumedAt: null,
                    createdAt: NOW,
                    updatedAt: NOW,
                  },
                  baselineName: 'CIS L1',
                },
              ]),
            }),
          }),
        }),
      } as any);

      const res = await app.request('/baselines/apply-requests');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].baselineName).toBe('CIS L1');
    });
  });

});
