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

  // ────────────────────── GET / (list monitors) ──────────────────────
  describe('GET / (list monitors)', () => {
    it('returns monitors for the org', async () => {
      const monitors = [
        {
          id: MONITOR_ID,
          orgId: ORG_ID,
          assetId: null,
          name: 'Google Ping',
          monitorType: 'icmp_ping',
          target: '8.8.8.8',
          config: {},
          pollingInterval: 60,
          timeout: 5,
          isActive: true,
          lastChecked: NOW,
          lastStatus: 'online',
          lastResponseMs: 12,
          lastError: null,
          consecutiveFailures: 0,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ];
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(monitors),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }]),
          }),
        } as any);

      const res = await app.request('/monitors');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe('Google Ping');
      expect(body.total).toBe(1);
    });

    it('filters by monitorType', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          }),
        } as any);

      const res = await app.request('/monitors?monitorType=tcp_port');
      expect(res.status).toBe(200);
    });

    it('filters by status', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          }),
        } as any);

      const res = await app.request('/monitors?status=offline');
      expect(res.status).toBe(200);
    });

    it('supports search parameter', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          }),
        } as any);

      const res = await app.request('/monitors?search=google');
      expect(res.status).toBe(200);
    });

    it('resolves orgId from assetId when assetId is provided', async () => {
      // First select: asset lookup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ orgId: ORG_ID }]),
          }),
        }),
      } as any);
      // Second select: monitors list
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);
      // Third select: count
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 0 }]),
        }),
      } as any);

      const res = await app.request(`/monitors?assetId=${ASSET_ID}`);
      expect(res.status).toBe(200);
    });

    it('returns 404 when assetId does not exist', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/monitors?assetId=${ASSET_ID}`);
      expect(res.status).toBe(404);
    });
  });

  // ────────────────────── POST / (create monitor) ──────────────────────
  describe('POST / (create monitor)', () => {
    it('creates an icmp_ping monitor', async () => {
      const created = {
        id: MONITOR_ID,
        orgId: ORG_ID,
        name: 'Ping Monitor',
        monitorType: 'icmp_ping',
        target: '8.8.8.8',
        config: {},
        pollingInterval: 60,
        timeout: 5,
        isActive: true,
        lastStatus: 'unknown',
        consecutiveFailures: 0,
        createdAt: NOW,
        updatedAt: NOW,
      };
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created]),
        }),
      } as any);

      const res = await app.request('/monitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Ping Monitor',
          monitorType: 'icmp_ping',
          target: '8.8.8.8',
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.id).toBe(MONITOR_ID);
      expect(body.data.monitorType).toBe('icmp_ping');
    });

    it('creates a tcp_port monitor with config', async () => {
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: MONITOR_ID,
            orgId: ORG_ID,
            name: 'SSH Check',
            monitorType: 'tcp_port',
            target: '10.0.0.1',
            config: { port: 22 },
          }]),
        }),
      } as any);

      const res = await app.request('/monitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'SSH Check',
          monitorType: 'tcp_port',
          target: '10.0.0.1',
          config: { port: 22 },
        }),
      });

      expect(res.status).toBe(201);
    });

    it('creates an http_check monitor', async () => {
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: MONITOR_ID,
            orgId: ORG_ID,
            name: 'Website Check',
            monitorType: 'http_check',
            target: 'https://example.com',
            config: { url: 'https://example.com', expectedStatus: 200 },
          }]),
        }),
      } as any);

      const res = await app.request('/monitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Website Check',
          monitorType: 'http_check',
          target: 'https://example.com',
          config: { url: 'https://example.com', expectedStatus: 200 },
        }),
      });

      expect(res.status).toBe(201);
    });

    it('validates tcp_port config requires port', async () => {
      const res = await app.request('/monitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Bad TCP',
          monitorType: 'tcp_port',
          target: '10.0.0.1',
          config: { expectBanner: 'SSH' },
        }),
      });

      expect(res.status).toBe(400);
    });

    it('validates http_check config requires valid url', async () => {
      const res = await app.request('/monitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Bad HTTP',
          monitorType: 'http_check',
          target: 'example.com',
          config: { url: 'not-a-url' },
        }),
      });

      expect(res.status).toBe(400);
    });

    it('validates polling interval bounds', async () => {
      const res = await app.request('/monitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Too Fast',
          monitorType: 'icmp_ping',
          target: '8.8.8.8',
          pollingInterval: 1, // Below minimum of 10
        }),
      });

      expect(res.status).toBe(400);
    });

    it('validates name is required', async () => {
      const res = await app.request('/monitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          monitorType: 'icmp_ping',
          target: '8.8.8.8',
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ────────────────────── GET /dashboard ──────────────────────
  describe('GET /dashboard', () => {
    it('returns dashboard summary', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 5 }]),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([
                { status: 'online', count: 3 },
                { status: 'offline', count: 2 },
              ]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([
                { monitorType: 'icmp_ping', count: 2 },
                { monitorType: 'http_check', count: 3 },
              ]),
            }),
          }),
        } as any);

      const res = await app.request('/monitors/dashboard');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.total).toBe(5);
      expect(body.data.status.online).toBe(3);
      expect(body.data.status.offline).toBe(2);
      expect(body.data.types.icmp_ping).toBe(2);
      expect(body.data.types.http_check).toBe(3);
    });
  });

  // ────────────────────── GET /:id (single monitor) ──────────────────────
  describe('GET /:id', () => {
    it('returns monitor detail with results and alert rules', async () => {
      const monitor = {
        id: MONITOR_ID,
        orgId: ORG_ID,
        name: 'Ping',
        monitorType: 'icmp_ping',
        target: '8.8.8.8',
        config: {},
        isActive: true,
        lastChecked: NOW,
        lastStatus: 'online',
        createdAt: NOW,
        updatedAt: NOW,
      };
      // Monitor lookup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([monitor]),
          }),
        }),
      } as any);
      // Recent results
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                { id: 'r-1', monitorId: MONITOR_ID, timestamp: NOW, status: 'online', responseMs: 15 },
              ]),
            }),
          }),
        }),
      } as any);
      // Alert rules
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const res = await app.request(`/monitors/${MONITOR_ID}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(MONITOR_ID);
      expect(body.data.recentResults).toHaveLength(1);
      expect(body.data.alertRules).toHaveLength(0);
    });

    it('returns 404 when monitor does not exist', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/monitors/${MONITOR_ID}`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('Monitor not found');
    });
  });

  // ────────────────────── PATCH /:id ──────────────────────
  describe('PATCH /:id', () => {
    it('updates a monitor', async () => {
      const monitor = {
        id: MONITOR_ID,
        orgId: ORG_ID,
        name: 'Ping',
        monitorType: 'icmp_ping',
        target: '8.8.8.8',
        isActive: true,
      };
      // Access check
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([monitor]),
          }),
        }),
      } as any);
      // Update
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ ...monitor, name: 'Updated Ping' }]),
          }),
        }),
      } as any);

      const res = await app.request(`/monitors/${MONITOR_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated Ping' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe('Updated Ping');
    });

    it('returns 404 when monitor not found', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/monitors/${MONITOR_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });

      expect(res.status).toBe(404);
    });
  });

  // ────────────────────── DELETE /:id ──────────────────────
  describe('DELETE /:id', () => {
    it('deletes a monitor', async () => {
      const monitor = {
        id: MONITOR_ID,
        orgId: ORG_ID,
        name: 'Ping',
      };
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([monitor]),
          }),
        }),
      } as any);
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([monitor]),
        }),
      } as any);

      const res = await app.request(`/monitors/${MONITOR_ID}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(MONITOR_ID);
    });

    it('returns 404 when monitor not found', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/monitors/${MONITOR_ID}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
    });
  });

  // ────────────────────── POST /:id/check ──────────────────────
  describe('POST /:id/check', () => {
    it('queues a monitor check via Redis', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: MONITOR_ID,
              orgId: ORG_ID,
              name: 'Ping',
            }]),
          }),
        }),
      } as any);

      const res = await app.request(`/monitors/${MONITOR_ID}/check`, {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe('queued');
      expect(vi.mocked(enqueueMonitorCheck)).toHaveBeenCalledWith(MONITOR_ID, ORG_ID);
    });

    it('returns 503 when Redis is unavailable', async () => {
      vi.mocked(isRedisAvailable).mockReturnValue(false);
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: MONITOR_ID,
              orgId: ORG_ID,
              name: 'Ping',
            }]),
          }),
        }),
      } as any);

      const res = await app.request(`/monitors/${MONITOR_ID}/check`, {
        method: 'POST',
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toContain('Redis');
    });
  });

  // ────────────────────── POST /:id/test ──────────────────────
  describe('POST /:id/test', () => {
    it('sends test command to an online agent', async () => {
      const monitor = {
        id: MONITOR_ID,
        orgId: ORG_ID,
        name: 'Ping',
        monitorType: 'icmp_ping',
        target: '8.8.8.8',
        config: {},
        timeout: 5,
      };
      // Access check
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([monitor]),
          }),
        }),
      } as any);
      // Find online agent
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ agentId: 'agent-1' }]),
          }),
        }),
      } as any);

      const res = await app.request(`/monitors/${MONITOR_ID}/test`, {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe('queued');
      expect(vi.mocked(sendCommandToAgent)).toHaveBeenCalled();
    });

    it('returns failed when no online agent is available', async () => {
      const monitor = {
        id: MONITOR_ID,
        orgId: ORG_ID,
        monitorType: 'icmp_ping',
        target: '8.8.8.8',
        config: {},
        timeout: 5,
      };
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([monitor]),
          }),
        }),
      } as any);
      // No online agent
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/monitors/${MONITOR_ID}/test`, {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe('failed');
      expect(body.data.error).toContain('No online agent');
    });
  });

  // ────────────────────── GET /:id/results ──────────────────────
  describe('GET /:id/results', () => {
    it('returns monitor check results', async () => {
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
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                { id: 'r-1', monitorId: MONITOR_ID, timestamp: NOW, status: 'online' },
              ]),
            }),
          }),
        }),
      } as any);

      const res = await app.request(`/monitors/${MONITOR_ID}/results`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    it('supports time range filters', async () => {
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
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      } as any);

      const res = await app.request(
        `/monitors/${MONITOR_ID}/results?start=2026-03-01&end=2026-03-13&limit=50`
      );
      expect(res.status).toBe(200);
    });
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

  // ────────────────────── buildMonitorCommand helper ──────────────────────
  describe('buildMonitorCommand', () => {
    it('builds icmp_ping command', () => {
      const cmd = buildMonitorCommand({
        id: MONITOR_ID,
        monitorType: 'icmp_ping',
        target: '8.8.8.8',
        config: { count: 5 },
        timeout: 10,
      });

      expect(cmd.type).toBe('network_ping');
      expect(cmd.payload.target).toBe('8.8.8.8');
      expect(cmd.payload.count).toBe(5);
      expect(cmd.payload.timeout).toBe(10);
      expect(cmd.id).toContain(`mon-${MONITOR_ID}`);
    });

    it('builds http_check command with url fallback', () => {
      const cmd = buildMonitorCommand({
        id: MONITOR_ID,
        monitorType: 'http_check',
        target: 'https://example.com',
        config: {},
        timeout: 30,
      });

      expect(cmd.type).toBe('network_http_check');
      expect(cmd.payload.url).toBe('https://example.com');
    });

    it('builds dns_check command with hostname fallback', () => {
      const cmd = buildMonitorCommand({
        id: MONITOR_ID,
        monitorType: 'dns_check',
        target: 'example.com',
        config: { recordType: 'A' },
        timeout: 5,
      });

      expect(cmd.type).toBe('network_dns_check');
      expect(cmd.payload.hostname).toBe('example.com');
      expect(cmd.payload.recordType).toBe('A');
    });

    it('throws for unknown monitor type', () => {
      expect(() =>
        buildMonitorCommand({
          id: MONITOR_ID,
          monitorType: 'unknown_type',
          target: '8.8.8.8',
          config: {},
          timeout: 5,
        })
      ).toThrow('Unknown monitor type');
    });
  });

  // ────────────────────── Multi-tenant isolation ──────────────────────
  describe('multi-tenant isolation', () => {
    it('org-scoped user cannot access another org monitor', async () => {
      // Monitor belongs to a different org
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/monitors/${MONITOR_ID}`);
      expect(res.status).toBe(404);
    });

    it('partner/system scope checks canAccessOrg for monitor access', async () => {
      setAuth({
        scope: 'partner',
        orgId: null,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (id: string) => id === ORG_ID,
      });

      // Monitor in inaccessible org
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: MONITOR_ID,
              orgId: ORG_ID_2,
            }]),
          }),
        }),
      } as any);

      const res = await app.request(`/monitors/${MONITOR_ID}`);
      expect(res.status).toBe(403);
    });
  });
});
