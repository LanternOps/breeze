import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Mock auth middleware so it doesn't try to read JWT tokens
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => await next(),
  requirePermission: () => async (c: any, next: any) => await next(),
  requireScope: () => async (c: any, next: any) => await next(),
}));

vi.mock('../services/reliabilityScoring', () => ({
  listReliabilityDevices: vi.fn(),
  getOrgReliabilitySummary: vi.fn(),
  getDeviceReliabilityHistory: vi.fn(),
  getDeviceReliabilityOffenders: vi.fn(),
  getDeviceReliability: vi.fn(),
  evaluateReliabilityScores: vi.fn(),
}));

vi.mock('../services/mlFeedbackEmitters', () => ({
  emitDeviceReliabilityFeedback: vi.fn(),
}));

vi.mock('./devices/helpers', () => ({
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: Symbol('SITE_ACCESS_DENIED'),
}));

import { reliabilityRoutes } from './reliability';
import {
  listReliabilityDevices,
  getOrgReliabilitySummary,
  getDeviceReliabilityHistory,
  getDeviceReliabilityOffenders,
  getDeviceReliability,
  evaluateReliabilityScores,
} from '../services/reliabilityScoring';
import { emitDeviceReliabilityFeedback } from '../services/mlFeedbackEmitters';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './devices/helpers';

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const ORG_ID_2 = '00000000-0000-0000-0000-000000000002';
const DEVICE_ID = '00000000-0000-0000-0000-000000000010';
const SITE_ID = '00000000-0000-0000-0000-000000000020';

type AuthOverrides = {
  scope?: 'organization' | 'partner' | 'system';
  orgId?: string | null;
  accessibleOrgIds?: string[] | null;
  canAccessOrg?: (id: string) => boolean;
  allowedSiteIds?: string[];
};

function buildApp(overrides: AuthOverrides = {}): Hono {
  const authSetter = async (c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
      token: {},
      partnerId: null,
      scope: overrides.scope ?? 'organization',
      orgId: 'orgId' in overrides ? overrides.orgId : ORG_ID,
      accessibleOrgIds: 'accessibleOrgIds' in overrides ? overrides.accessibleOrgIds : [ORG_ID],
      canAccessOrg: overrides.canAccessOrg ?? ((id: string) => id === ORG_ID),
    });
    c.set('permissions', { allowedSiteIds: overrides.allowedSiteIds });
    await next();
  };
  const app = new Hono();
  // Need both patterns: '/reliability' (root) and '/reliability/*' (sub-paths)
  app.use('/reliability', authSetter);
  app.use('/reliability/*', authSetter);
  app.route('/reliability', reliabilityRoutes);
  return app;
}

describe('public reliability routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ──────────────────────────────────────────────────────────
  // GET /  (list)
  // ──────────────────────────────────────────────────────────
  describe('GET / (list)', () => {
    it('returns 200 with empty results for org-scoped user', async () => {
      vi.mocked(listReliabilityDevices).mockResolvedValue({ total: 0, rows: [] });

      const app = buildApp();
      const res = await app.request('/reliability');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination).toEqual({
        total: 0,
        page: 1,
        limit: 25,
        totalPages: 1,
      });
      expect(body.summary).toEqual({
        averageScore: 0,
        criticalDevices: 0,
        degradingDevices: 0,
      });

      // Should have been called with orgIds derived from auth.orgId
      expect(vi.mocked(listReliabilityDevices)).toHaveBeenCalledWith(
        expect.objectContaining({ orgIds: [ORG_ID] }),
      );
    });

    it('returns 403 when orgId query param is not accessible to the user', async () => {
      const app = buildApp();
      const res = await app.request(`/reliability?orgId=${ORG_ID_2}`);
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.error).toMatch(/access denied/i);
    });

    it('returns 400 when partner user has empty accessibleOrgIds and no org context', async () => {
      const app = buildApp({
        scope: 'partner',
        orgId: null,
        accessibleOrgIds: [],
        canAccessOrg: () => false,
      });

      const res = await app.request('/reliability');
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toMatch(/organization context required/i);
    });

    it('allows system scope with no org context', async () => {
      vi.mocked(listReliabilityDevices).mockResolvedValue({ total: 0, rows: [] });

      const app = buildApp({
        scope: 'system',
        orgId: null,
        accessibleOrgIds: null,
        canAccessOrg: () => true,
      });

      const res = await app.request('/reliability');
      expect(res.status).toBe(200);

      // orgIds should be undefined for system scope (no filter)
      expect(vi.mocked(listReliabilityDevices)).toHaveBeenCalledWith(
        expect.objectContaining({ orgIds: undefined }),
      );
    });
  });

  // ──────────────────────────────────────────────────────────
  // GET /org/:orgId/summary
  // ──────────────────────────────────────────────────────────
  describe('GET /org/:orgId/summary', () => {
    it('returns 403 when user cannot access the org', async () => {
      const app = buildApp();
      const res = await app.request(`/reliability/org/${ORG_ID_2}/summary`);
      expect(res.status).toBe(403);
    });

    it('returns 200 with summary for accessible org', async () => {
      const summary = {
        orgId: ORG_ID,
        devices: 5,
        averageScore: 72,
        criticalDevices: 1,
        poorDevices: 1,
        fairDevices: 2,
        goodDevices: 1,
        degradingDevices: 1,
        topIssues: [],
      };
      vi.mocked(getOrgReliabilitySummary).mockResolvedValue(summary);
      vi.mocked(listReliabilityDevices).mockResolvedValue({ total: 0, rows: [] });

      const app = buildApp();
      const res = await app.request(`/reliability/org/${ORG_ID}/summary`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.summary).toEqual(summary);
      expect(body.worstDevices).toEqual([]);
    });

    it('scopes summary and worst devices to allowed sites for site-restricted users', async () => {
      const summary = {
        orgId: ORG_ID,
        devices: 1,
        averageScore: 48,
        criticalDevices: 1,
        poorDevices: 0,
        fairDevices: 0,
        goodDevices: 0,
        degradingDevices: 1,
        topIssues: [{ type: 'crashes' as const, count: 2 }],
      };
      vi.mocked(getOrgReliabilitySummary).mockResolvedValue(summary);
      vi.mocked(listReliabilityDevices).mockResolvedValue({ total: 1, rows: [{ deviceId: DEVICE_ID }] as any });

      const app = buildApp({ allowedSiteIds: [SITE_ID] });
      const res = await app.request(`/reliability/org/${ORG_ID}/summary`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.summary).toEqual(summary);
      expect(body.worstDevices).toEqual([{ deviceId: DEVICE_ID }]);
      expect(vi.mocked(getOrgReliabilitySummary)).toHaveBeenCalledWith(ORG_ID, { siteIds: [SITE_ID] });
      expect(vi.mocked(listReliabilityDevices)).toHaveBeenCalledWith({
        orgId: ORG_ID,
        siteIds: [SITE_ID],
        limit: 10,
        offset: 0,
      });
    });
  });

  describe('GET /evaluation', () => {
    it('returns reliability evaluation summary for accessible org context', async () => {
      const summary = {
        atRiskMaxScore: 70,
        labelWindowDays: 90,
        evaluatedDevices: 3,
        atRiskDevices: 2,
        labeledAtRiskDevices: 2,
        truePositiveDevices: 1,
        falsePositiveDevices: 1,
        missedFailureDevices: 0,
        unlabeledAtRiskDevices: 0,
        confirmedFailureLabels: 1,
        replacementLabels: 0,
        falseAlarmLabels: 1,
        precision: 0.5,
      };
      vi.mocked(evaluateReliabilityScores).mockResolvedValue(summary);

      const app = buildApp();
      const res = await app.request('/reliability/evaluation?atRiskMaxScore=70&labelWindowDays=90');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.summary).toEqual(summary);
      expect(vi.mocked(evaluateReliabilityScores)).toHaveBeenCalledWith(expect.objectContaining({
        orgIds: [ORG_ID],
        atRiskMaxScore: 70,
        labelWindowDays: 90,
      }));
    });

    it('returns 403 when evaluation orgId is not accessible', async () => {
      const app = buildApp();
      const res = await app.request(`/reliability/evaluation?orgId=${ORG_ID_2}`);
      expect(res.status).toBe(403);
      expect(vi.mocked(evaluateReliabilityScores)).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────
  // GET /:deviceId  (detail)
  // ──────────────────────────────────────────────────────────
  describe('GET /:deviceId (detail)', () => {
    it('returns 404 when device is not found', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null);

      const app = buildApp();
      const res = await app.request(`/reliability/${DEVICE_ID}`);
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error).toMatch(/device not found/i);
    });

    it('returns 404 when no reliability snapshot exists yet', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: ORG_ID } as any);
      vi.mocked(getDeviceReliability).mockResolvedValue(null);
      vi.mocked(getDeviceReliabilityHistory).mockResolvedValue([]);

      const app = buildApp();
      const res = await app.request(`/reliability/${DEVICE_ID}`);
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error).toMatch(/no reliability snapshot/i);
    });

    it('returns 200 with snapshot and history when device exists', async () => {
      const snapshot = {
        deviceId: DEVICE_ID,
        orgId: ORG_ID,
        reliabilityScore: 85,
        trendDirection: 'stable' as const,
      };
      const history = [
        { collectedAt: '2026-02-19T00:00:00Z', uptimeSeconds: 86400, reliabilityScore: 82 },
        { collectedAt: '2026-02-20T00:00:00Z', uptimeSeconds: 86400, reliabilityScore: 85 },
      ];

      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: ORG_ID } as any);
      vi.mocked(getDeviceReliability).mockResolvedValue(snapshot as any);
      vi.mocked(getDeviceReliabilityHistory).mockResolvedValue(history as any);

      const app = buildApp();
      const res = await app.request(`/reliability/${DEVICE_ID}`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.snapshot).toEqual(snapshot);
      expect(body.history).toEqual(history);
    });

    it('returns 403 when device site is denied', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);

      const app = buildApp();
      const res = await app.request(`/reliability/${DEVICE_ID}`);
      expect(res.status).toBe(403);
      expect(vi.mocked(getDeviceReliability)).not.toHaveBeenCalled();
    });
  });

  describe('POST /:deviceId/feedback', () => {
    it('emits reliability feedback with snapshot metadata', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: ORG_ID } as any);
      vi.mocked(getDeviceReliability).mockResolvedValue({
        deviceId: DEVICE_ID,
        orgId: ORG_ID,
        siteId: 'site-1',
        hostname: 'host-1',
        osType: 'windows',
        status: 'online',
        reliabilityScore: 42,
        trendDirection: 'degrading',
        trendConfidence: 0.8,
        uptime30d: 96,
        crashCount30d: 3,
        hangCount30d: 0,
        serviceFailureCount30d: 0,
        hardwareErrorCount30d: 1,
        mtbfHours: 120,
        topIssues: [{ type: 'crashes', count: 3, severity: 'critical' }],
        computedAt: '2026-06-18T12:00:00.000Z',
      } as any);

      const app = buildApp();
      const res = await app.request(`/reliability/${DEVICE_ID}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome: 'false_alarm', metadata: { note: 'Known maintenance window' } }),
      });

      expect(res.status).toBe(200);
      expect(vi.mocked(emitDeviceReliabilityFeedback)).toHaveBeenCalledWith(expect.objectContaining({
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        eventType: 'device.false_alarm',
        dedupeKey: 'snapshot:2026-06-18T12:00:00.000Z:false_alarm',
        outcome: 'false_alarm',
        actorUserId: 'user-1',
        metadata: expect.objectContaining({
          note: 'Known maintenance window',
          reliabilityScore: 42,
        }),
      }));
    });

    it('uses sourceEventId as the reliability feedback replay key when provided', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
        id: DEVICE_ID,
        orgId: ORG_ID,
        siteId: 'site-1',
      } as any);
      vi.mocked(getDeviceReliability).mockResolvedValue({
        deviceId: DEVICE_ID,
        orgId: ORG_ID,
        reliabilityScore: 42,
        trendDirection: 'degrading',
        trendConfidence: 0.8,
        uptime30d: 96,
        crashCount30d: 3,
        hangCount30d: 0,
        serviceFailureCount30d: 0,
        hardwareErrorCount30d: 1,
        mtbfHours: 120,
        topIssues: [],
        computedAt: '2026-06-18T12:00:00.000Z',
      } as any);

      const sourceEventId = '00000000-0000-0000-0000-000000000030';
      const app = buildApp();
      const res = await app.request(`/reliability/${DEVICE_ID}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome: 'failure_confirmed', sourceEventId }),
      });

      expect(res.status).toBe(200);
      expect(vi.mocked(emitDeviceReliabilityFeedback)).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'device.failure_confirmed',
        dedupeKey: `source:${sourceEventId}:failure_confirmed`,
      }));
    });

    it('rejects inconsistent feedback payloads through validation', async () => {
      const app = buildApp();
      const res = await app.request(`/reliability/${DEVICE_ID}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome: 'resolved' }),
      });

      expect(res.status).toBe(400);
      expect(vi.mocked(emitDeviceReliabilityFeedback)).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────
  // GET /:deviceId/history
  // ──────────────────────────────────────────────────────────
  describe('GET /:deviceId/history', () => {
    it('returns 404 when device not found', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null);

      const app = buildApp();
      const res = await app.request(`/reliability/${DEVICE_ID}/history`);
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error).toMatch(/device not found/i);
    });

    it('returns 200 with history for accessible device', async () => {
      const points = [
        { collectedAt: '2026-02-18T00:00:00Z', uptimeSeconds: 86400, reliabilityScore: 80 },
        { collectedAt: '2026-02-19T00:00:00Z', uptimeSeconds: 86400, reliabilityScore: 82 },
        { collectedAt: '2026-02-20T00:00:00Z', uptimeSeconds: 86400, reliabilityScore: 85 },
      ];

      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: ORG_ID } as any);
      vi.mocked(getDeviceReliabilityHistory).mockResolvedValue(points as any);

      const app = buildApp();
      const res = await app.request(`/reliability/${DEVICE_ID}/history`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.deviceId).toBe(DEVICE_ID);
      expect(body.days).toBe(90); // default
      expect(body.points).toEqual(points);
    });

    it('respects custom days query parameter', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: ORG_ID } as any);
      vi.mocked(getDeviceReliabilityHistory).mockResolvedValue([]);

      const app = buildApp();
      const res = await app.request(`/reliability/${DEVICE_ID}/history?days=30`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.days).toBe(30);

      expect(vi.mocked(getDeviceReliabilityHistory)).toHaveBeenCalledWith(DEVICE_ID, 30);
    });
  });

  // ──────────────────────────────────────────────────────────
  // GET /:deviceId/offenders
  // ──────────────────────────────────────────────────────────
  describe('GET /:deviceId/offenders', () => {
    const offenders = {
      services: [{ key: 'Spooler', label: 'Spooler', count: 3, lastOccurrence: '2026-06-20T10:00:00.000Z' }],
      hardware: [],
      hangs: [],
    };

    it('returns 404 when device not found', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null);

      const app = buildApp();
      const res = await app.request(`/reliability/${DEVICE_ID}/offenders`);
      expect(res.status).toBe(404);
      expect(vi.mocked(getDeviceReliabilityOffenders)).not.toHaveBeenCalled();
    });

    it('returns 403 when device site is denied', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);

      const app = buildApp();
      const res = await app.request(`/reliability/${DEVICE_ID}/offenders`);
      expect(res.status).toBe(403);
      expect(vi.mocked(getDeviceReliabilityOffenders)).not.toHaveBeenCalled();
    });

    it('returns offenders with default window and limit', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: ORG_ID } as any);
      vi.mocked(getDeviceReliabilityOffenders).mockResolvedValue(offenders as any);

      const app = buildApp();
      const res = await app.request(`/reliability/${DEVICE_ID}/offenders`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ deviceId: DEVICE_ID, days: 30, offenders });
      expect(vi.mocked(getDeviceReliabilityOffenders)).toHaveBeenCalledWith(DEVICE_ID, 30, 5);
    });

    it('passes custom days and limit through to the service', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: ORG_ID } as any);
      vi.mocked(getDeviceReliabilityOffenders).mockResolvedValue(offenders as any);

      const app = buildApp();
      const res = await app.request(`/reliability/${DEVICE_ID}/offenders?days=7&limit=3`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.days).toBe(7);
      expect(vi.mocked(getDeviceReliabilityOffenders)).toHaveBeenCalledWith(DEVICE_ID, 7, 3);
    });

    it('rejects an out-of-range limit through validation', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: ORG_ID } as any);

      const app = buildApp();
      const res = await app.request(`/reliability/${DEVICE_ID}/offenders?limit=50`);
      expect(res.status).toBe(400);
      expect(vi.mocked(getDeviceReliabilityOffenders)).not.toHaveBeenCalled();
    });

    it('rejects an out-of-range days through validation', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: ORG_ID } as any);

      const app = buildApp();
      const res = await app.request(`/reliability/${DEVICE_ID}/offenders?days=400`);
      expect(res.status).toBe(400);
      expect(vi.mocked(getDeviceReliabilityOffenders)).not.toHaveBeenCalled();
    });
  });
});
