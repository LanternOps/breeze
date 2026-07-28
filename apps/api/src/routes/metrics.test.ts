import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const selectMock = vi.hoisted(() => vi.fn());

// Site scope carried by `c.get('permissions')`. `undefined` is unrestricted,
// `[]` is restricted-to-no-sites; the two must never be conflated.
const permissionState = vi.hoisted(() => ({
  permissions: undefined as { allowedSiteIds?: string[] } | undefined,
}));

vi.mock('../services', () => ({}));

// Structural stand-ins for the condition builders so tests can inspect the
// predicate tree the route hands to Drizzle. Everything else (sql, avg,
// pg-core column construction) keeps its real implementation.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    and: (...conditions: unknown[]) => ({
      op: 'and',
      conditions: conditions.filter(Boolean),
    }),
    eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
    gte: (column: unknown, value: unknown) => ({ op: 'gte', column, value }),
    inArray: (column: unknown, values: unknown) => ({ op: 'inArray', column, values }),
  };
});

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: selectMock,
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    if (!c.req.header('Authorization')) {
      return c.json({ error: 'Missing authorization header' }, 401);
    }
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com' },
      scope: 'system',
      orgId: 'org-123'
    });
    c.set('permissions', permissionState.permissions);
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

import { authMiddleware } from '../middleware/auth';
import { devices } from '../db/schema';
import {
  metricsMiddleware,
  metricsRoutes,
  recordAgentHeartbeat,
  recordBackupCommandTimeout,
  recordBackupDispatchFailure,
  recordBackupVerificationResult,
  recordBackupVerificationSkip,
  recordHttpRequest,
  recordRestoreTimeout,
  recordScriptExecution,
  recordSensitiveDataFinding,
  recordSensitiveDataRemediationDecision,
  recordSensitiveDataScanQueued,
  resetMetricsForTesting,
  setLowReadinessDevices,
  updateBusinessMetrics,
} from './metrics';
import {
  recordAgentEnrollment,
  recordCommandDispatch,
  recordFailedLogin,
} from '../services/anomalyMetrics';
import {
  getS1MetricsSnapshot,
  recordS1ActionDispatch,
  recordS1ActionPollTransition,
  recordS1SyncRun,
} from '../services/sentinelOne/metrics';

function mockRollupTrendRows(selectMock: ReturnType<typeof vi.fn>, rows: unknown[]) {
  selectMock.mockReturnValueOnce({
    from: () => ({
      where: () => ({
        groupBy: () => ({
          orderBy: () => Promise.resolve(rows),
        }),
      }),
    }),
  });
}

function mockRawTrendRows(selectMock: ReturnType<typeof vi.fn>, rows: unknown[]) {
  selectMock.mockReturnValueOnce({
    from: () => ({
      innerJoin: () => ({
        where: () => ({
          groupBy: () => ({
            orderBy: () => Promise.resolve(rows),
          }),
        }),
      }),
    }),
  });
}

/** Finds a `{op, column, value}` node anywhere in a mocked condition tree. */
function findCondition(condition: any, op: string, column: unknown): any | undefined {
  if (!condition || typeof condition !== 'object') return undefined;
  if (condition.op === 'and' || condition.op === 'or') {
    for (const child of condition.conditions ?? []) {
      const found = findCondition(child, op, column);
      if (found) return found;
    }
    return undefined;
  }
  return condition.op === op && condition.column === column ? condition : undefined;
}

type ScopedRow = { siteId: string | null };

function rowAllowedByCondition(row: ScopedRow, condition: any): boolean {
  const siteFilter = findCondition(condition, 'inArray', devices.siteId);
  if (!siteFilter) return true;
  return row.siteId !== null && (siteFilter.values as string[]).includes(row.siteId);
}

/**
 * Mocks the three aggregate queries `GET /metrics/` issues (device status
 * counts, active remote sessions, 30-day remote sessions) and records the
 * WHERE condition each one received.
 */
function mockCurrentMetricsQueries(
  deviceRows: Array<ScopedRow & { status: string }>,
  activeSessionRows: ScopedRow[],
  recentSessionRows: ScopedRow[]
): any[] {
  const captured: any[] = [];

  selectMock
    .mockReturnValueOnce({
      from: () => ({
        where: (condition: any) => {
          captured.push(condition);
          const visible = deviceRows.filter((row) => rowAllowedByCondition(row, condition));
          const byStatus = new Map<string, number>();
          for (const row of visible) {
            byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
          }
          return {
            groupBy: () =>
              Promise.resolve(
                [...byStatus.entries()].map(([status, count]) => ({ status, count }))
              ),
          };
        },
      }),
    })
    .mockReturnValueOnce({
      from: () => ({
        innerJoin: () => ({
          where: (condition: any) => {
            captured.push(condition);
            return Promise.resolve([
              { count: activeSessionRows.filter((row) => rowAllowedByCondition(row, condition)).length },
            ]);
          },
        }),
      }),
    })
    .mockReturnValueOnce({
      from: () => ({
        innerJoin: () => ({
          where: (condition: any) => {
            captured.push(condition);
            return Promise.resolve([
              { count: recentSessionRows.filter((row) => rowAllowedByCondition(row, condition)).length },
            ]);
          },
        }),
      }),
    });

  return captured;
}

function getMetricLine(metrics: string, name: string, labels?: Record<string, string>): string | undefined {
  const labelText = labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}` : '';
  return metrics
    .split('\n')
    .find((line) => line.startsWith(`${name}${labelText} `));
}

describe('metrics routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    selectMock.mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([{ count: 0 }]),
      }),
    });
    permissionState.permissions = undefined;
    process.env.NODE_ENV = 'test';
    process.env.METRICS_SCRAPE_TOKEN = 'test-scrape-token';
    delete process.env.METRICS_INCLUDE_ORG_ID;
    resetMetricsForTesting();
    app = new Hono();
    app.route('/', metricsRoutes);
  });

  it('returns Prometheus metrics with defaults', async () => {
    const res = await app.request('/metrics', {
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('# HELP http_requests_total Total number of HTTP requests');
    expect(body).toContain('http_requests_in_flight 0');
    expect(body).toContain('agent_heartbeat_total{status="success"} 0');
  });

  it('registers the action-intents counter on the live registry', async () => {
    const res = await app.request('/metrics', {
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('# HELP breeze_action_intents_total');
    expect(body).toContain('# TYPE breeze_action_intents_total counter');
  });

  it('registers both M365 customer-graph consent counters on the live registry', async () => {
    const res = await app.request('/metrics', {
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    // Read and actions consent surfaces must both be registered so their
    // recorders are live (not the default no-op). The actions counter was
    // once defined but never registered here — this guards that regression.
    expect(body).toContain('# HELP breeze_m365_customer_graph_read_events_total');
    expect(body).toContain('# HELP breeze_m365_customer_graph_actions_events_total');
  });

  it('requires auth for metrics endpoints', async () => {
    const res = await app.request('/metrics');
    expect(res.status).toBe(401);
  });

  it('uses daily metric rollups for trend metrics when available', async () => {
    const { db } = await import('../db');
    const selectMock = vi.mocked(db.select);
    mockRollupTrendRows(selectMock, [
      { bucket: new Date('2026-06-17T00:00:00.000Z'), metricName: 'cpu_percent', value: 12.4 },
      { bucket: new Date('2026-06-17T00:00:00.000Z'), metricName: 'ram_percent', value: 66.6 },
      { bucket: new Date('2026-06-18T00:00:00.000Z'), metricName: 'cpu_percent', value: 20 },
      { bucket: new Date('2026-06-18T00:00:00.000Z'), metricName: 'ram_percent', value: 70 },
    ]);

    const res = await app.request('/trends?range=7d', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { timestamp: '2026-06-17T00:00:00.000Z', cpu: 12, memory: 67 },
      { timestamp: '2026-06-18T00:00:00.000Z', cpu: 20, memory: 70 },
    ]);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to raw device metrics for trend metrics when rollups are empty', async () => {
    const { db } = await import('../db');
    const selectMock = vi.mocked(db.select);
    mockRollupTrendRows(selectMock, []);
    mockRawTrendRows(selectMock, [
      { bucket: '2026-06-18T00:00:00.000Z', cpu: 21.2, memory: 75.8 },
    ]);

    const res = await app.request('/trends?range=7d', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { timestamp: '2026-06-18T00:00:00.000Z', cpu: 21, memory: 76 },
    ]);
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('requires scrape token for /scrape endpoint', async () => {
    const unauthorizedRes = await app.request('/scrape');
    expect(unauthorizedRes.status).toBe(401);

    const res = await app.request('/scrape', {
      headers: { Authorization: 'Bearer test-scrape-token' }
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
  });

  it('returns 503 for /scrape when token is not configured', async () => {
    delete process.env.METRICS_SCRAPE_TOKEN;
    resetMetricsForTesting();

    const res = await app.request('/scrape', {
      headers: { Authorization: 'Bearer test-scrape-token' }
    });
    expect(res.status).toBe(503);
  });

  it('records and aggregates HTTP request metrics', async () => {
    recordHttpRequest('GET', '/api/devices/123', 200, 0.2, 'org-1');
    recordHttpRequest('GET', '/api/devices/456', 200, 0.4, 'org-1');

    const res = await app.request('/metrics', {
      headers: { Authorization: 'Bearer token' }
    });
    const body = await res.text();

    const counterLine = getMetricLine(body, 'http_requests_total', {
      method: 'GET',
      route: '/api/devices/:id',
      status: '200',
      org_id: 'org-1'
    });
    expect(counterLine).toBeDefined();
    expect(counterLine?.endsWith(' 2')).toBe(true);

    const countLine = getMetricLine(body, 'http_request_duration_seconds_count', {
      method: 'GET',
      route: '/api/devices/:id'
    });
    expect(countLine).toBeDefined();
    expect(countLine?.endsWith(' 2')).toBe(true);
  });

  it('captures request metrics via middleware with org context', async () => {
    const appWithMiddleware = new Hono();
    appWithMiddleware.use('*', authMiddleware);
    appWithMiddleware.use('*', metricsMiddleware);
    appWithMiddleware.get('/widgets/:id', (c) => c.json({ ok: true }));
    appWithMiddleware.route('/', metricsRoutes);

    const res = await appWithMiddleware.request('/widgets/42', {
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(200);

    const metricsRes = await appWithMiddleware.request('/metrics', {
      headers: { Authorization: 'Bearer token' }
    });
    const body = await metricsRes.text();

    const counterLine = getMetricLine(body, 'http_requests_total', {
      method: 'GET',
      route: '/widgets/:id',
      status: '200',
      org_id: 'org-123'
    });
    expect(counterLine).toBeDefined();
    expect(counterLine?.endsWith(' 1')).toBe(true);
  });

  it('aggregates business metrics and counters', async () => {
    updateBusinessMetrics({
      devicesActive: 12,
      organizationsTotal: 3,
      alertsActive: 5,
      alertQueueLength: 2
    });
    recordAgentHeartbeat('success');
    recordAgentHeartbeat('failed');
    recordAgentHeartbeat('success');
    recordScriptExecution();
    recordScriptExecution();

    const res = await app.request('/json', {
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.business_metrics.breeze_active_devices).toBe(12);
    expect(body.business_metrics.breeze_active_organizations).toBe(3);
    expect(body.business_metrics.alert_queue_length).toBe(2);
    expect(body.business_metrics.scripts_executed_total).toBe(2);
    expect(body.agent_heartbeats).toEqual(
      expect.arrayContaining([
        { labels: { status: 'success' }, value: 2 },
        { labels: { status: 'failed' }, value: 1 }
      ])
    );
  });

  it('records sensitive-data metrics', async () => {
    recordSensitiveDataScanQueued(3);
    recordSensitiveDataFinding('credential', 'critical', 2);
    recordSensitiveDataRemediationDecision('encrypt_completed', 1);

    const jsonRes = await app.request('/json', {
      headers: { Authorization: 'Bearer token' }
    });
    const body = await jsonRes.json();

    expect(body.business_metrics.sensitive_data_scans_queued_total).toBe(3);
    expect(body.sensitive_data.scans_queued_total).toBe(3);
    expect(body.sensitive_data.findings).toEqual(
      expect.arrayContaining([
        { labels: { data_type: 'credential', risk: 'critical' }, value: 2 }
      ])
    );
    expect(body.sensitive_data.remediation_decisions).toEqual(
      expect.arrayContaining([
        { labels: { decision: 'encrypt_completed' }, value: 1 }
      ])
    );
  });

  it('clears SentinelOne snapshot state when resetting metrics', () => {
    recordS1SyncRun('sync-integration', 'success', 25);
    recordS1ActionDispatch('isolate', 'accepted');
    recordS1ActionPollTransition('completed');

    expect(getS1MetricsSnapshot().syncRuns).toHaveLength(1);

    resetMetricsForTesting();

    expect(getS1MetricsSnapshot()).toEqual({
      syncRuns: [],
      actionDispatches: [],
      actionPollTransitions: [],
    });
  });

  it('records backup operational metrics', async () => {
    selectMock.mockReturnValueOnce({
      from: () => ({
        where: () => Promise.resolve([{ count: 3 }]),
      }),
    });
    recordBackupDispatchFailure('manual_restore', 'device_offline');
    recordBackupCommandTimeout('mssql_backup', 'sync_wait');
    recordBackupVerificationResult('test_restore', 'failed');
    recordBackupVerificationSkip('test_restore', 'device_offline');
    recordRestoreTimeout('backup_restore');
    setLowReadinessDevices(3);

    const jsonRes = await app.request('/json', {
      headers: { Authorization: 'Bearer token' }
    });
    const body = await jsonRes.json();

    expect(body.backup_operations.dispatch_failures).toEqual(
      expect.arrayContaining([
        { labels: { operation: 'manual_restore', reason: 'device_offline' }, value: 1 }
      ])
    );
    expect(body.backup_operations.verification_skips).toEqual(
      expect.arrayContaining([
        { labels: { verification_type: 'test_restore', reason: 'device_offline' }, value: 1 }
      ])
    );
    expect(body.backup_operations.verification_results).toEqual(
      expect.arrayContaining([
        { labels: { verification_type: 'test_restore', status: 'failed' }, value: 1 }
      ])
    );
    expect(body.backup_operations.restore_timeouts).toEqual(
      expect.arrayContaining([
        { labels: { command_type: 'backup_restore' }, value: 1 }
      ])
    );
    expect(body.backup_operations.command_timeouts).toEqual(
      expect.arrayContaining([
        { labels: { command_type: 'mssql_backup', source: 'sync_wait' }, value: 1 }
      ])
    );
    expect(body.backup_operations.low_readiness_devices).toBe(3);
  });

  it('records anomaly counters with tenant attribution (non-production)', async () => {
    recordFailedLogin('invalid_password', 'org-1');
    recordFailedLogin('invalid_password', 'org-1');
    recordFailedLogin('rate_limited_ip');
    recordAgentEnrollment('success', 'partner-1');
    recordAgentEnrollment('denied');
    recordCommandDispatch('reboot', 'user', 'org-1');
    recordCommandDispatch('script', 'system');

    const res = await app.request('/metrics', {
      headers: { Authorization: 'Bearer token' }
    });
    const body = await res.text();

    expect(
      getMetricLine(body, 'breeze_failed_logins_total', { reason: 'invalid_password', tenant: 'org-1' })?.endsWith(' 2')
    ).toBe(true);
    // No tenant id supplied → 'unknown' (not redacted) outside production.
    expect(
      getMetricLine(body, 'breeze_failed_logins_total', { reason: 'rate_limited_ip', tenant: 'unknown' })?.endsWith(' 1')
    ).toBe(true);
    expect(
      getMetricLine(body, 'breeze_agent_enrollments_total', { result: 'success', tenant: 'partner-1' })?.endsWith(' 1')
    ).toBe(true);
    expect(
      getMetricLine(body, 'breeze_agent_enrollments_total', { result: 'denied', tenant: 'unknown' })?.endsWith(' 1')
    ).toBe(true);
    expect(
      getMetricLine(body, 'breeze_commands_dispatched_total', { type: 'reboot', actor: 'user', tenant: 'org-1' })?.endsWith(' 1')
    ).toBe(true);
    expect(
      getMetricLine(body, 'breeze_commands_dispatched_total', { type: 'script', actor: 'system', tenant: 'unknown' })?.endsWith(' 1')
    ).toBe(true);
  });

  it('redacts the tenant label on anomaly counters in production', async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.METRICS_SCRAPE_TOKEN = 'test-scrape-token';
    resetMetricsForTesting();
    try {
      recordFailedLogin('invalid_password', 'org-secret');
      recordAgentEnrollment('success', 'partner-secret');
      recordCommandDispatch('reboot', 'user', 'org-secret');

      const prodApp = new Hono();
      prodApp.route('/', metricsRoutes);
      const res = await prodApp.request('/scrape', {
        headers: { Authorization: 'Bearer test-scrape-token' }
      });
      const body = await res.text();

      // Tenant ids must not leak into Prometheus labels in production.
      expect(body).not.toContain('org-secret');
      expect(body).not.toContain('partner-secret');
      expect(
        getMetricLine(body, 'breeze_failed_logins_total', { reason: 'invalid_password', tenant: 'redacted' })?.endsWith(' 1')
      ).toBe(true);
      expect(
        getMetricLine(body, 'breeze_agent_enrollments_total', { result: 'success', tenant: 'redacted' })?.endsWith(' 1')
      ).toBe(true);
      expect(
        getMetricLine(body, 'breeze_commands_dispatched_total', { type: 'reboot', actor: 'user', tenant: 'redacted' })?.endsWith(' 1')
      ).toBe(true);
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      resetMetricsForTesting();
    }
  });

  describe('GET / current metrics site scope', () => {
    const SITE_A = '22222222-2222-2222-2222-222222222222';
    const SITE_B = '33333333-3333-3333-3333-333333333333';

    const deviceRows = [
      { status: 'online', siteId: SITE_A },
      { status: 'offline', siteId: SITE_B },
      { status: 'online', siteId: null },
    ];
    const activeSessionRows = [
      { siteId: SITE_A },
      { siteId: SITE_B },
      { siteId: null },
    ];
    const recentSessionRows = [
      { siteId: SITE_A },
      { siteId: SITE_A },
      { siteId: SITE_B },
      { siteId: null },
    ];

    it('excludes other-site and null-site devices and remote sessions for a restricted caller', async () => {
      permissionState.permissions = { allowedSiteIds: [SITE_A] };
      const captured = mockCurrentMetricsQueries(deviceRows, activeSessionRows, recentSessionRows);

      const res = await app.request('/', { headers: { Authorization: 'Bearer token' } });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.devices).toEqual({ total: 1, online: 1, offline: 0, pending: 0 });
      expect(body.data.remoteSessions).toBe(1);
      expect(body.data.sessions).toBe(2);
      expect(body.data.business_metrics).toEqual({
        devices_total: 1,
        devices_active: 1,
        devices_pending: 0,
      });

      // Every aggregate — including both remote-session counts, which must
      // join through devices — carries the same allowed-site predicate.
      expect(captured).toHaveLength(3);
      for (const condition of captured) {
        const siteFilter = findCondition(condition, 'inArray', devices.siteId);
        expect(siteFilter).toBeDefined();
        expect(siteFilter.values).toEqual([SITE_A]);
      }
    });

    it('returns zero-safe metrics without issuing any select for a restricted-empty caller', async () => {
      permissionState.permissions = { allowedSiteIds: [] };
      mockCurrentMetricsQueries(deviceRows, activeSessionRows, recentSessionRows);

      const res = await app.request('/', { headers: { Authorization: 'Bearer token' } });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: {
          uptime: 0,
          remoteSessions: 0,
          sessions: 0,
          devices: { total: 0, online: 0, offline: 0, pending: 0 },
          business_metrics: {
            devices_total: 0,
            devices_active: 0,
            devices_pending: 0,
          },
        },
      });
      expect(selectMock).not.toHaveBeenCalled();
    });

    it('leaves the unrestricted query chains unchanged', async () => {
      const captured = mockCurrentMetricsQueries(deviceRows, activeSessionRows, recentSessionRows);

      const res = await app.request('/', { headers: { Authorization: 'Bearer token' } });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.devices).toEqual({ total: 3, online: 2, offline: 1, pending: 0 });
      expect(body.data.remoteSessions).toBe(3);
      expect(body.data.sessions).toBe(4);

      expect(captured).toHaveLength(3);
      for (const condition of captured) {
        expect(findCondition(condition, 'inArray', devices.siteId)).toBeUndefined();
      }
    });
  });

  describe('GET /trends site scope', () => {
    const SITE_A = '22222222-2222-2222-2222-222222222222';

    it('denies a site-restricted caller before any aggregate query', async () => {
      permissionState.permissions = { allowedSiteIds: [SITE_A] };

      const res = await app.request('/trends?range=7d', {
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'Trend metrics are unavailable for site-restricted users',
        code: 'SITE_SCOPED_TRENDS_UNAVAILABLE',
      });
      expect(selectMock).not.toHaveBeenCalled();
    });

    it('denies a restricted-empty caller before any aggregate query', async () => {
      permissionState.permissions = { allowedSiteIds: [] };

      const res = await app.request('/trends?range=7d', {
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'Trend metrics are unavailable for site-restricted users',
        code: 'SITE_SCOPED_TRENDS_UNAVAILABLE',
      });
      expect(selectMock).not.toHaveBeenCalled();
    });

    it('still serves an unrestricted caller', async () => {
      const { db } = await import('../db');
      const trendSelectMock = vi.mocked(db.select);
      mockRollupTrendRows(trendSelectMock, [
        { bucket: new Date('2026-06-18T00:00:00.000Z'), metricName: 'cpu_percent', value: 20 },
        { bucket: new Date('2026-06-18T00:00:00.000Z'), metricName: 'ram_percent', value: 70 },
      ]);

      const res = await app.request('/trends?range=7d', {
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([
        { timestamp: '2026-06-18T00:00:00.000Z', cpu: 20, memory: 70 },
      ]);
    });
  });
});
