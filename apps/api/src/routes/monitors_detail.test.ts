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

    // #5751 W03 (#5754): a check result already in flight was produced under
    // the OLD target/config, and recordMonitorCheckResult overwrites monitor
    // state unconditionally. Without invalidation, an arriving certificate
    // would be attributed to an endpoint it never came from.
    describe('TLS observation invalidation', () => {
      const EXISTING = {
        id: MONITOR_ID,
        orgId: ORG_ID,
        name: 'Web',
        monitorType: 'http_check',
        target: 'https://a.example',
        config: { url: 'https://a.example', method: 'GET' },
        isActive: true,
      };

      /** Runs one PATCH and returns the `set()` payload the route produced. */
      async function patchAndCaptureSet(payload: Record<string, unknown>) {
        const setSpy = vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([EXISTING]),
          }),
        });
        vi.mocked(db.select).mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([EXISTING]),
            }),
          }),
        } as any);
        vi.mocked(db.update).mockReturnValueOnce({ set: setSpy } as any);

        const res = await app.request(`/monitors/${MONITOR_ID}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        expect(res.status).toBe(200);
        return setSpy.mock.calls[0]![0] as Record<string, unknown>;
      }

      const TLS_COLUMNS = ['tlsState', 'tlsNotAfter', 'tlsIssuer', 'tlsObservedHost', 'tlsObservedAt'];

      it('clears every tls_* column when target changes', async () => {
        const set = await patchAndCaptureSet({ target: 'https://b.example' });
        for (const column of TLS_COLUMNS) expect(set[column]).toBeNull();
      });

      it('clears every tls_* column when config changes', async () => {
        const set = await patchAndCaptureSet({ config: { url: 'https://a.example', method: 'HEAD' } });
        for (const column of TLS_COLUMNS) expect(set[column]).toBeNull();
      });

      it('leaves the observation alone when only name changes', async () => {
        const set = await patchAndCaptureSet({ name: 'Renamed' });
        for (const column of TLS_COLUMNS) expect(set).not.toHaveProperty(column);
      });

      it('leaves the observation alone when target is re-sent unchanged', async () => {
        const set = await patchAndCaptureSet({ target: EXISTING.target, name: 'Renamed' });
        for (const column of TLS_COLUMNS) expect(set).not.toHaveProperty(column);
      });

      it('leaves the observation alone when config is re-sent with the same values', async () => {
        const set = await patchAndCaptureSet({ config: { url: 'https://a.example', method: 'GET' } });
        for (const column of TLS_COLUMNS) expect(set).not.toHaveProperty(column);
      });
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

});
