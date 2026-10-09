/**
 * Dashboard AV / firewall counts with an unknown reading (#8252).
 *
 * A NULL `real_time_protection` / `firewall_enabled` means the agent's
 * collector failed. It must be reported in its own `unknown` bucket, never
 * folded into `unprotected` / `disabled`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', async () => {
  const actual = await vi.importActual<any>('../../db');
  return { ...actual, db: { select: vi.fn() } };
});

vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return {
    ...actual,
    requireScope: vi.fn(() => async (_c: any, next: any) => next()),
    requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  };
});

vi.mock('../../services/securityPosture', () => ({
  listLatestSecurityPosture: vi.fn(async () => []),
  getSecurityPostureTrend: vi.fn(async () => []),
}));

const { listStatusRowsMock } = vi.hoisted(() => ({ listStatusRowsMock: vi.fn() }));

vi.mock('./helpers', async () => {
  const actual = await vi.importActual<any>('./helpers');
  return {
    ...actual,
    listStatusRows: listStatusRowsMock,
    listThreatRows: vi.fn(async () => []),
    buildBe9Recommendations: vi.fn(async () => ({ recommendations: [] })),
  };
});

import { dashboardRoutes } from './dashboard';

const ORG = '33333333-3333-4333-8333-333333333333';

function statusRow(overrides: Record<string, unknown>) {
  return {
    deviceId: 'dev', orgId: ORG, deviceName: 'pc', os: 'windows', deviceState: 'online',
    provider: 'windows_defender', providerVersion: null, definitionsVersion: null,
    definitionsDate: null, realTimeProtection: true, threatCount: 0,
    firewallEnabled: true, encryptionStatus: 'encrypted', encryptionDetails: null,
    localAdminSummary: null, passwordPolicySummary: null, gatekeeperEnabled: null,
    lastScan: null, lastScanType: null,
    ...overrides,
  };
}

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization', orgId: ORG, partnerId: null,
      accessibleOrgIds: [ORG], user: { id: 'u' },
      orgCondition: () => undefined, canAccessOrg: () => true,
    } as any);
    await next();
  });
  app.route('/security', dashboardRoutes);
  return app;
}

describe('GET /dashboard — unknown AV / firewall state', () => {
  beforeEach(() => vi.clearAllMocks());

  it('counts unknown separately from protected/unprotected and enabled/disabled', async () => {
    listStatusRowsMock.mockResolvedValue([
      statusRow({ deviceId: 'on', realTimeProtection: true, firewallEnabled: true }),
      statusRow({ deviceId: 'off', realTimeProtection: false, firewallEnabled: false }),
      statusRow({ deviceId: 'unknown', realTimeProtection: null, firewallEnabled: null }),
    ]);

    const res = await buildApp().request('/security/dashboard');
    expect(res.status).toBe(200);
    const { data } = await res.json();

    expect(data.antivirus).toEqual({ protected: 1, unprotected: 1, unknown: 1 });
    expect(data.firewall).toEqual({ enabled: 1, disabled: 1, unknown: 1 });
    expect(data.firewallEnabled).toBe(1);
    expect(data.firewallDisabled).toBe(1);
    // Fallback (no posture rows) posture buckets: the unknown device is
    // neither protected nor in the reported-off device's risk bucket.
    expect(data.protectedDevices).toBe(1);
  });
});
