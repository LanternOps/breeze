import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const middlewareGate = vi.hoisted(() => ({ denied: '' }));

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
    managedByMonitorId: 'networkMonitors.managedByMonitorId',
    retiredAt: 'networkMonitors.retiredAt',
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
  requireScope: vi.fn(() => async (c: any, next: any) => middlewareGate.denied === 'scope' ? c.json({ error: 'Forbidden' }, 403) : next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => middlewareGate.denied === 'permission' ? c.json({ error: 'Forbidden' }, 403) : next()),
  requireMfa: vi.fn(() => async (c: any, next: any) => middlewareGate.denied === 'mfa' ? c.json({ error: 'MFA required' }, 403) : next()),
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
    middlewareGate.denied = '';
    setAuth();
    app = makeApp();
  });

  describe.each([
    ['POST', '/monitors'],
    ['PATCH', `/monitors/${MONITOR_ID}`],
    ['DELETE', `/monitors/${MONITOR_ID}`],
    ['POST', '/monitors/alerts'],
    ['PATCH', `/monitors/alerts/${RULE_ID}`],
    ['DELETE', `/monitors/alerts/${RULE_ID}`],
  ])('%s %s middleware', (method, path) => {
    it('returns 401 before the retired response for unauthenticated callers', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any) => c.json({ error: 'Unauthorized' }, 401));
      const res = await app.request(path, { method });
      expect(res.status).toBe(401);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
    });

    it.each(['scope', 'permission', 'mfa'])('retains the %s gate', async (gate) => {
      middlewareGate.denied = gate;
      const res = await app.request(path, { method });
      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
    });
  });

  // ────────────────────── GET / (list monitors) ──────────────────────
  describe('GET / (list monitors)', () => {
    it('returns monitors for the org', async () => {
      const monitors = [
        {
          id: MONITOR_ID,
          orgId: ORG_ID,
          assetId: null,
          managedByMonitorId: RULE_ID,
          retiredAt: null,
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
      expect(body.data[0]).toMatchObject({ managedByMonitorId: RULE_ID, retiredAt: null });
    });

    it.each([
      {
        tlsState: 'observed',
        tlsNotAfter: new Date('2026-12-01T00:00:00Z'),
        tlsIssuer: 'Example CA',
        tlsObservedHost: 'example.com',
        tlsObservedAt: NOW,
      },
      {
        tlsState: null,
        tlsNotAfter: null,
        tlsIssuer: null,
        tlsObservedHost: null,
        tlsObservedAt: null,
      },
    ])('returns TLS observation fields when state is $tlsState', async (tls) => {
      const monitor = {
        id: MONITOR_ID,
        orgId: ORG_ID,
        name: 'Website Check',
        monitorType: 'http_check',
        target: 'https://example.com',
        createdAt: NOW,
        updatedAt: NOW,
        ...tls,
      };
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([monitor]),
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
      expect(body.data[0]).toMatchObject({
        ...tls,
        tlsNotAfter: tls.tlsNotAfter?.toISOString() ?? null,
        tlsObservedAt: tls.tlsObservedAt?.toISOString() ?? null,
      });
    });

    it.each(['', '?includeRetired=false', '?includeRetired=true'])(
      'applies the retirement filter to both list and count for %s', async (query) => {
        const listWhere = vi.fn().mockReturnValue({ orderBy: vi.fn().mockResolvedValue([{
          id: MONITOR_ID, orgId: ORG_ID, managedByMonitorId: null,
          retiredAt: NOW, createdAt: NOW, updatedAt: NOW,
        }]) });
        const countWhere = vi.fn().mockResolvedValue([{ count: 1 }]);
        vi.mocked(db.select)
          .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: listWhere }) } as any)
          .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: countWhere }) } as any);
        const res = await app.request(`/monitors${query}`);
        expect(res.status).toBe(200);
        for (const where of [listWhere, countWhere]) {
          const filter = JSON.stringify(where.mock.calls[0]![0]);
          if (query === '?includeRetired=true') expect(filter).not.toContain('networkMonitors.retiredAt');
          else expect(filter).toContain('networkMonitors.retiredAt');
        }
        expect((await res.json()).data[0]).toMatchObject({
          managedByMonitorId: null, retiredAt: NOW.toISOString(),
        });
      },
    );

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

  describe('POST / (retired authoring)', () => {
    it.each([
      { name: 'Ping', monitorType: 'icmp_ping', target: '8.8.8.8' },
      { name: 'TCP', monitorType: 'tcp_port', target: 'example.com', config: { port: 443 } },
      { name: 'HTTP', monitorType: 'http_check', target: 'https://example.com' },
      {},
    ])('returns 410 without inserting for %j', async (payload) => {
      const res = await app.request('/monitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(410);
      expect(await res.json()).toMatchObject({
        error: 'network_check_authoring_retired',
        hint: { route: 'POST /monitor-definitions', kind: 'network_check' },
      });
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
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

});
