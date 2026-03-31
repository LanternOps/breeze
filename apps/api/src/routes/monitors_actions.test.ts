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
    siteId: 'devices.siteId',
    agentId: 'devices.agentId',
    status: 'devices.status',
    lastSeenAt: 'devices.lastSeenAt',
    enrolledAt: 'devices.enrolledAt',
  },
  discoveredAssets: {
    id: 'discoveredAssets.id',
    orgId: 'discoveredAssets.orgId',
    siteId: 'discoveredAssets.siteId',
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
    it('prefers an online agent from the monitored asset site', async () => {
      const monitor = {
        id: MONITOR_ID,
        orgId: ORG_ID,
        assetId: ASSET_ID,
        name: 'Ping',
        monitorType: 'icmp_ping',
        target: '8.8.8.8',
        config: {},
        timeout: 5,
      };
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([monitor]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ siteId: 'site-001' }]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ agentId: 'site-agent-1' }]),
            }),
          }),
        } as any);

      const res = await app.request(`/monitors/${MONITOR_ID}/test`, {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      expect(vi.mocked(sendCommandToAgent)).toHaveBeenCalledWith(
        'site-agent-1',
        expect.objectContaining({ payload: expect.objectContaining({ monitorId: MONITOR_ID }) })
      );
    });

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

  describe('PATCH /:id', () => {
    it('rejects invalid config updates for the monitor type', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: MONITOR_ID,
              orgId: ORG_ID,
              monitorType: 'tcp_port',
            }]),
          }),
        }),
      } as any);

      const res = await app.request(`/monitors/${MONITOR_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: { url: 'https://example.com' }
        })
      });

      expect(res.status).toBe(400);
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
      const body = await res.json();
      expect(body.error).toBe('Invalid monitor config');
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
