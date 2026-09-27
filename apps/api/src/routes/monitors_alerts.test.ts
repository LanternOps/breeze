import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  networkMonitors: {
    id: 'networkMonitors.id',
    orgId: 'networkMonitors.orgId',
    assetId: 'networkMonitors.assetId',
    name: 'networkMonitors.name',
    monitorType: 'networkMonitors.monitorType',
    target: 'networkMonitors.target',
    config: 'networkMonitors.config',
    pollingInterval: 'networkMonitors.pollingInterval',
    timeout: 'networkMonitors.timeout',
    isActive: 'networkMonitors.isActive',
    lastChecked: 'networkMonitors.lastChecked',
    lastStatus: 'networkMonitors.lastStatus',
    lastResponseMs: 'networkMonitors.lastResponseMs',
    lastError: 'networkMonitors.lastError',
    consecutiveFailures: 'networkMonitors.consecutiveFailures',
    createdAt: 'networkMonitors.createdAt',
    updatedAt: 'networkMonitors.updatedAt',
  },
  networkMonitorResults: {
    id: 'networkMonitorResults.id',
    monitorId: 'networkMonitorResults.monitorId',
    timestamp: 'networkMonitorResults.timestamp',
    status: 'networkMonitorResults.status',
    responseMs: 'networkMonitorResults.responseMs',
    error: 'networkMonitorResults.error',
  },
  networkMonitorAlertRules: {
    id: 'networkMonitorAlertRules.id',
    monitorId: 'networkMonitorAlertRules.monitorId',
    condition: 'networkMonitorAlertRules.condition',
    threshold: 'networkMonitorAlertRules.threshold',
    severity: 'networkMonitorAlertRules.severity',
    message: 'networkMonitorAlertRules.message',
    isActive: 'networkMonitorAlertRules.isActive',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    agentId: 'devices.agentId',
    status: 'devices.status',
  },
  discoveredAssets: {
    id: 'discoveredAssets.id',
    orgId: 'discoveredAssets.orgId',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/redis', () => ({
  isRedisAvailable: vi.fn().mockReturnValue(true),
}));

vi.mock('../routes/agentWs', () => ({
  sendCommandToAgent: vi.fn().mockReturnValue(true),
  isAgentConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../jobs/monitorWorker', () => ({
  enqueueMonitorCheck: vi.fn(),
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { monitorRoutes, buildMonitorCommand } from './monitors';
import { isRedisAvailable } from '../services/redis';
import { sendCommandToAgent, isAgentConnected } from '../routes/agentWs';
import { enqueueMonitorCheck } from '../jobs/monitorWorker';

// ── Constants ──────────────────────────────────────────────────────

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID_2 = '22222222-2222-2222-2222-222222222222';
const MONITOR_ID = '33333333-3333-3333-3333-333333333333';
const ASSET_ID = '44444444-4444-4444-4444-444444444444';
const RULE_ID = '55555555-5555-5555-5555-555555555555';
const DEVICE_ID = '66666666-6666-6666-6666-666666666666';
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
  app.route('/monitors', monitorRoutes);
  return app;
}

// ── Tests ──────────────────────────────────────────────────────────


describe('monitors routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    app = makeApp();
  });

  it.each([
    ['POST', '/monitors/alerts'],
    ['PATCH', `/monitors/alerts/${RULE_ID}`],
    ['DELETE', `/monitors/alerts/${RULE_ID}`],
  ])('%s %s returns 410 without reading or writing rules', async (method, path) => {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitorId: MONITOR_ID, condition: 'offline', severity: 'critical' }),
    });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({
      error: 'network_check_authoring_retired',
      hint: { route: 'POST /monitor-definitions', kind: 'network_check' },
    });
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  // ────────────────────── GET /:monitorId/alerts ──────────────────────
  describe('GET /:monitorId/alerts', () => {
    it('lists alert rules for a monitor', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: MONITOR_ID,
              orgId: ORG_ID,
            }]),
          }),
        }),
      } as any);
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: RULE_ID, monitorId: MONITOR_ID, condition: 'offline', severity: 'critical' },
          ]),
        }),
      } as any);

      const res = await app.request(`/monitors/${MONITOR_ID}/alerts`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });
  });

});
