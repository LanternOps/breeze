import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Mock auth middleware so it doesn't try to read JWT tokens
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => await next(),
  requireScope: () => async (c: any, next: any) => await next(),
}));

vi.mock('../services/reliabilityScoring', () => ({
  listReliabilityDevices: vi.fn(),
  getOrgReliabilitySummary: vi.fn(),
  getDeviceReliabilityHistory: vi.fn(),
  getDeviceReliability: vi.fn(),
}));

vi.mock('./devices/helpers', () => ({
  getDeviceWithOrgCheck: vi.fn(),
}));

import { reliabilityRoutes } from './reliability';
import {
  listReliabilityDevices,
  getOrgReliabilitySummary,
  getDeviceReliabilityHistory,
  getDeviceReliability,
} from '../services/reliabilityScoring';
import { getDeviceWithOrgCheck } from './devices/helpers';

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const ORG_ID_2 = '00000000-0000-0000-0000-000000000002';
const DEVICE_ID = '00000000-0000-0000-0000-000000000010';

type AuthOverrides = {
  scope?: 'organization' | 'partner' | 'system';
  orgId?: string | null;
  accessibleOrgIds?: string[] | null;
  canAccessOrg?: (id: string) => boolean;
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
  });

  // ──────────────────────────────────────────────────────────
  // GET /:deviceId  (detail)
  // ──────────────────────────────────────────────────────────
  describe('GET /:deviceId (detail)', () => {
    it('returns 404 when device is not found', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(null);

      const app = buildApp();
      const res = await app.request(`/reliability/${DEVICE_ID}`);
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error).toMatch(/device not found/i);
    });

    it('returns 404 when no reliability snapshot exists yet', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({ id: DEVICE_ID, orgId: ORG_ID } as any);
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

      vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({ id: DEVICE_ID, orgId: ORG_ID } as any);
      vi.mocked(getDeviceReliability).mockResolvedValue(snapshot as any);
      vi.mocked(getDeviceReliabilityHistory).mockResolvedValue(history as any);

      const app = buildApp();
      const res = await app.request(`/reliability/${DEVICE_ID}`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.snapshot).toEqual(snapshot);
      expect(body.history).toEqual(history);
    });
  });

  // ──────────────────────────────────────────────────────────
  // GET /:deviceId/history
  // ──────────────────────────────────────────────────────────
  describe('GET /:deviceId/history', () => {
    it('returns 404 when device not found', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(null);

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

      vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({ id: DEVICE_ID, orgId: ORG_ID } as any);
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
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({ id: DEVICE_ID, orgId: ORG_ID } as any);
      vi.mocked(getDeviceReliabilityHistory).mockResolvedValue([]);

      const app = buildApp();
      const res = await app.request(`/reliability/${DEVICE_ID}/history?days=30`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.days).toBe(30);

      expect(vi.mocked(getDeviceReliabilityHistory)).toHaveBeenCalledWith(DEVICE_ID, 30);
    });
  });
});
