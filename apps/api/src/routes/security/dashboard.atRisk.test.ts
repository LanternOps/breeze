/**
 * Gate B #6 (dashboard click-through A-2): is there a list whose population
 * equals the dashboard's "N at risk"?
 *
 * Verdict: NO. The dashboard computes at-risk from posture `riskLevel`
 * (medium | high; falling back to agent `at_risk` only when there are no posture
 * rows). The only page-level list under /devices/posture is the fleet
 * management-posture report, which partitions devices by detected management
 * product freshness (never scanned / stale / detected), not by risk level. The
 * risk-level population is only reachable through `GET /security/posture`,
 * which no web page renders. So `security.atRisk` stays `exempt` in the
 * dashboard registry (pinned in AlertsVulnsSecurity.links.test.tsx); neither
 * computation is changed to force equality.
 *
 * This file pins the two facts the verdict rests on, on a mixed fixture.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => {
  const chain = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const method of ['from', 'leftJoin', 'innerJoin', 'where', 'orderBy', 'groupBy', 'limit']) {
      b[method] = () => b;
    }
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve([]).then(resolve, reject);
    return b;
  };
  return {
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    db: { select: vi.fn(() => chain()) },
  };
});

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: {},
  queueCommand: vi.fn(async () => undefined),
}));

vi.mock('../../services/securityPosture', () => ({
  listLatestSecurityPosture: vi.fn(async () => []),
  getSecurityPostureTrend: vi.fn(async () => []),
  getLatestSecurityPostureForDevice: vi.fn(async () => null),
}));

const { getUserPermissionsMock } = vi.hoisted(() => ({ getUserPermissionsMock: vi.fn() }));

vi.mock('../../services/permissions', async () => {
  const actual = await vi.importActual<any>('../../services/permissions');
  return { ...actual, getUserPermissions: getUserPermissionsMock };
});

vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return { ...actual, requireScope: vi.fn(() => async (_c: any, next: any) => next()) };
});

import { listLatestSecurityPosture } from '../../services/securityPosture';
import { MANAGEMENT_POSTURE_CATEGORIES } from '../../services/managementPostureReport';
import { dashboardRoutes } from './dashboard';
import { postureRoutes } from './posture';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      canAccessOrg: (id: string) => id === ORG_ID,
      orgCondition: () => undefined,
      canAccessSite: () => true,
    } as any);
    await next();
  });
  app.route('/security', dashboardRoutes);
  app.route('/security', postureRoutes);
  return app;
}

const FACTOR_KEYS = [
  'patch_compliance', 'encryption', 'av_health', 'firewall',
  'open_ports', 'password_policy', 'os_currency', 'admin_exposure',
];

const item = (deviceId: string, riskLevel: string, deviceStatus = 'online', overallScore = 70) => ({
  orgId: ORG_ID,
  deviceId,
  deviceName: deviceId,
  osType: 'windows',
  deviceStatus,
  capturedAt: '2026-10-01T00:00:00.000Z',
  overallScore,
  riskLevel,
  factors: Object.fromEntries(FACTOR_KEYS.map((k) => [k, { score: overallScore, status: 'pass', details: {} }])),
  recommendations: [],
});

// Mixed: 1 low online, 1 low offline, 2 medium, 1 high, 1 critical.
const MIXED = [
  item('d-low', 'low'),
  item('d-low-offline', 'low', 'offline'),
  item('d-med-1', 'medium'),
  item('d-med-2', 'medium', 'offline'),
  item('d-high', 'high'),
  item('d-crit', 'critical'),
];

describe('dashboard "at risk" population (Gate B #6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });
    vi.mocked(listLatestSecurityPosture).mockResolvedValue(MIXED as never);
  });

  it('counts posture devices at riskLevel medium|high (offline included, critical excluded)', async () => {
    const res = await buildApp().request('/security/dashboard');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.atRiskDevices).toBe(3);
    expect(data.unprotectedDevices).toBe(1); // critical is its own bucket
    expect(data.totalDevices).toBe(MIXED.length);
  });

  it('the only risk-level list (GET /security/posture) agrees, but no web page renders it', async () => {
    const res = await buildApp().request('/security/posture');
    expect(res.status).toBe(200);
    const body = await res.json();
    const summary = body.summary ?? body.data?.summary;
    expect(summary.mediumRiskDevices + summary.highRiskDevices).toBe(3);
  });

  it('the /devices/posture report has no risk dimension, so no link can reproduce the count', () => {
    // Its categories are management-product families; none is a risk bucket.
    expect(MANAGEMENT_POSTURE_CATEGORIES.length).toBeGreaterThan(0);
    for (const category of MANAGEMENT_POSTURE_CATEGORIES) {
      expect(category).not.toMatch(/risk/i);
    }
  });
});
