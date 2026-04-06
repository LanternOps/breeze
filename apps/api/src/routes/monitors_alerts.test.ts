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

  // ────────────────────── POST /alerts (create alert rule) ──────────────────────
  describe('POST /alerts', () => {
    it('creates an alert rule for a monitor', async () => {
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
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: RULE_ID,
            monitorId: MONITOR_ID,
            condition: 'offline',
            severity: 'critical',
            isActive: true,
          }]),
        }),
      } as any);

      const res = await app.request('/monitors/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          monitorId: MONITOR_ID,
          condition: 'offline',
          severity: 'critical',
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.condition).toBe('offline');
      expect(body.data.severity).toBe('critical');
    });

    it('validates condition enum', async () => {
      const res = await app.request('/monitors/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          monitorId: MONITOR_ID,
          condition: 'invalid_condition',
          severity: 'high',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('validates severity enum', async () => {
      const res = await app.request('/monitors/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          monitorId: MONITOR_ID,
          condition: 'offline',
          severity: 'unknown',
        }),
      });

      expect(res.status).toBe(400);
    });
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

  // ────────────────────── PATCH /alerts/:id ──────────────────────
  describe('PATCH /alerts/:id', () => {
    it('updates an alert rule', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                rule: { id: RULE_ID, monitorId: MONITOR_ID },
                monitorOrgId: ORG_ID,
              }]),
            }),
          }),
        }),
      } as any);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: RULE_ID,
              severity: 'high',
            }]),
          }),
        }),
      } as any);

      const res = await app.request(`/monitors/alerts/${RULE_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ severity: 'high' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.severity).toBe('high');
    });

    it('returns 404 when alert rule not found', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      } as any);

      const res = await app.request(`/monitors/alerts/${RULE_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ severity: 'high' }),
      });

      expect(res.status).toBe(404);
    });
  });

  // ────────────────────── DELETE /alerts/:id ──────────────────────
  describe('DELETE /alerts/:id', () => {
    it('deletes an alert rule', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                rule: { id: RULE_ID },
                monitorOrgId: ORG_ID,
              }]),
            }),
          }),
        }),
      } as any);
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: RULE_ID }]),
        }),
      } as any);

      const res = await app.request(`/monitors/alerts/${RULE_ID}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
    });
  });

});
