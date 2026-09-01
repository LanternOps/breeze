import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EventLoopLagMonitor,
  stopEventLoopMonitor,
  __setEventLoopMonitorForTests,
} from '../services/eventLoopMonitor';
import {
  DB_POOL_HEALTH_VERDICTS,
  runDbPoolHealthCheck,
  __resetDbPoolHealthMonitorForTests,
} from '../db/dbPoolHealthMonitor';
import {
  recordDbConnectTimeout,
  __resetDbConnectTimeoutStatsForTests,
  type DbConnectTimeoutWindowStats,
} from '../services/dbConnectTimeoutStats';
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

// Records the ORDER in which db-context wrappers are entered, so a test can prove
// the fleet query actually ran inside them. `toHaveBeenCalled()` alone is not
// enough — see the nesting test below for why.
const dbContextEvents = vi.hoisted(() => [] as string[]);

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => {
    dbContextEvents.push('outside:enter');
    return fn();
  }),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    dbContextEvents.push('system:enter');
    try {
      return await fn();
    } finally {
      dbContextEvents.push('system:exit');
    }
  }),
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
import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices } from '../db/schema';
// Real dialect + real `sql` (the drizzle-orm mock above spreads the original and
// replaces only the condition builders), so a captured predicate can be compiled
// to the exact text Postgres would receive.
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
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

/** Stand-in connect-timeout window, so the pool-health tests need no real errors. */
function connectTimeoutStats(timeouts: number, windowMs = 300_000): DbConnectTimeoutWindowStats {
  return {
    timeouts,
    byCause: { 'event-loop-starvation': 0, connectivity: timeouts, unknown: 0 },
    windowMs,
    ratePerMin: (timeouts * 60_000) / windowMs,
    totalSinceStart: timeouts,
  };
}

/**
 * Stubs the single fleet-gauge pass (device counts + backup readiness) by TABLE
 * rather than by call order, so reordering the two queries inside the shared
 * transaction cannot break unrelated suites.
 */
function stubFleetGaugeQueries(
  selectMock: ReturnType<typeof vi.fn>,
  opts: { fleet?: Record<string, unknown>; readiness?: Record<string, unknown> } = {}
): void {
  selectMock.mockImplementation(() => {
    // The readiness half joins `devices` (#3969); the fleet half does not. One
    // chain object serving both keeps this stub indifferent to which.
    const chain: Record<string, any> = {};
    chain.from = (table: unknown) => {
      chain._table = table;
      return chain;
    };
    chain.innerJoin = () => chain;
    chain.where = () =>
      Promise.resolve([
        chain._table === devices
          ? (opts.fleet ?? { devicesActive: 0, organizationsActive: 0 })
          : (opts.readiness ?? { count: 0 }),
      ]);
    return chain;
  });
}

function getMetricLine(metrics: string, name: string, labels?: Record<string, string>): string | undefined {
  const labelText = labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}` : '';
  return metrics
    .split('\n')
    .find((line) => line.startsWith(`${name}${labelText} `));
}

/**
 * Install a real EventLoopLagMonitor driven by a fake clock and a fake
 * histogram, so the gauges are exercised through the genuine
 * getEventLoopLagStats / readLatestEventLoopLag path rather than a stub of it.
 */
function installFakeMonitor(first: {
  maxLagMs: number;
  meanLagMs: number;
  /** Wall-clock to advance past the sample, simulating a still-blocked loop. */
  advanceAfterSampleMs?: number;
}): { pushSample: (s: { maxLagMs: number; meanLagMs: number }) => void } {
  const NS = 1e6;
  const histogram = { max: 0, mean: 0, enable: () => true, disable: () => true, reset() { this.max = 0; this.mean = 0; } };
  let now = 5_000_000;
  const sampleIntervalMs = 1_000;
  const monitor = new EventLoopLagMonitor({
    sampleIntervalMs,
    now: () => now,
    createHistogram: () => histogram as never,
  });
  monitor.start();

  const push = (sample: { maxLagMs: number; meanLagMs: number }) => {
    histogram.max = sample.maxLagMs * NS;
    histogram.mean = sample.meanLagMs * NS;
    now += sampleIntervalMs;
    monitor.sampleNow();
  };

  push(first);
  if (first.advanceAfterSampleMs) now += first.advanceAfterSampleMs;

  __setEventLoopMonitorForTests(monitor);
  return { pushSample: push };
}

describe('metrics routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    dbContextEvents.length = 0;
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

  // #3022 — these four gauges are the durable production artifact of the
  // event-loop work. Without a test, deleting the `updateEventLoopMetrics()`
  // call leaves them pinned at their initialize-time zeros, and every dashboard
  // reads a perfectly healthy loop forever.
  describe('event-loop gauges (#3022)', () => {
    afterEach(() => {
      stopEventLoopMonitor();
      __setEventLoopMonitorForTests(null);
      delete process.env.EVENT_LOOP_STARVATION_WARN_MS;
    });

    async function scrape(): Promise<string> {
      const res = await app.request('/metrics', { headers: { Authorization: 'Bearer token' } });
      expect(res.status).toBe(200);
      return res.text();
    }

    it('publishes every series even with no monitor running', async () => {
      const body = await scrape();
      expect(body).toContain('# TYPE breeze_nodejs_eventloop_lag_max_seconds gauge');
      expect(body).toContain('# TYPE breeze_nodejs_eventloop_lag_window_max_seconds gauge');
      expect(body).toContain('# TYPE breeze_nodejs_eventloop_lag_window_mean_seconds gauge');
      expect(body).toContain('# TYPE breeze_nodejs_eventloop_starved gauge');
      // The one that keeps a blind instance from reading as a healthy one.
      expect(getMetricLine(body, 'breeze_nodejs_eventloop_monitored')).toBe(
        'breeze_nodejs_eventloop_monitored 0',
      );
    });

    it('tracks a running monitor and reports lag in SECONDS', async () => {
      process.env.EVENT_LOOP_STARVATION_WARN_MS = '1000';
      installFakeMonitor({ maxLagMs: 2_500, meanLagMs: 40 });

      const body = await scrape();
      expect(getMetricLine(body, 'breeze_nodejs_eventloop_monitored')).toBe(
        'breeze_nodejs_eventloop_monitored 1',
      );
      // 2500ms -> 2.5s. A ms value here would be 1000x off in every dashboard.
      expect(getMetricLine(body, 'breeze_nodejs_eventloop_lag_max_seconds')).toBe(
        'breeze_nodejs_eventloop_lag_max_seconds 2.5',
      );
      expect(getMetricLine(body, 'breeze_nodejs_eventloop_lag_window_mean_seconds')).toBe(
        'breeze_nodejs_eventloop_lag_window_mean_seconds 0.04',
      );
      expect(getMetricLine(body, 'breeze_nodejs_eventloop_starved')).toBe(
        'breeze_nodejs_eventloop_starved 1',
      );
    });

    it('clears `starved` once the loop recovers, rather than smearing the spike', async () => {
      process.env.EVENT_LOOP_STARVATION_WARN_MS = '1000';
      const monitor = installFakeMonitor({ maxLagMs: 9_000, meanLagMs: 20 });
      // A later, healthy interval. The 9s spike stays the window high-water
      // mark, but the instantaneous gauge must fall back to the current value —
      // otherwise `starved == 1 for 1m` fires on a momentary blip.
      monitor.pushSample({ maxLagMs: 5, meanLagMs: 2 });

      const body = await scrape();
      expect(getMetricLine(body, 'breeze_nodejs_eventloop_starved')).toBe(
        'breeze_nodejs_eventloop_starved 0',
      );
      expect(getMetricLine(body, 'breeze_nodejs_eventloop_lag_max_seconds')).toBe(
        'breeze_nodejs_eventloop_lag_max_seconds 0.005',
      );
      expect(getMetricLine(body, 'breeze_nodejs_eventloop_lag_window_max_seconds')).toBe(
        'breeze_nodejs_eventloop_lag_window_max_seconds 9',
      );
      // The mean must be named for the same time base as the window max, not
      // read as the partner of the instantaneous max — otherwise a recovered
      // loop publishes a max below its mean.
      expect(getMetricLine(body, 'breeze_nodejs_eventloop_lag_window_mean_seconds')).toBe(
        'breeze_nodejs_eventloop_lag_window_mean_seconds 0.011',
      );
    });

    it('reports a stall that is still in flight, so a mid-stall scrape is not healthy', async () => {
      process.env.EVENT_LOOP_STARVATION_WARN_MS = '1000';
      installFakeMonitor({ maxLagMs: 3, meanLagMs: 1, advanceAfterSampleMs: 8_000 });

      const body = await scrape();
      // 8s elapsed since the last sample, 1s of which is the scheduled interval.
      expect(getMetricLine(body, 'breeze_nodejs_eventloop_lag_max_seconds')).toBe(
        'breeze_nodejs_eventloop_lag_max_seconds 7',
      );
      expect(getMetricLine(body, 'breeze_nodejs_eventloop_starved')).toBe(
        'breeze_nodejs_eventloop_starved 1',
      );
    });
  });

  describe('db pool-health gauges (#3214)', () => {
    afterEach(() => {
      __resetDbPoolHealthMonitorForTests();
      __resetDbConnectTimeoutStatsForTests();
    });

    async function scrape(): Promise<string> {
      const res = await app.request('/metrics', { headers: { Authorization: 'Bearer token' } });
      expect(res.status).toBe(200);
      return res.text();
    }

    it('publishes every series, all at zero, before the watchdog has evaluated', async () => {
      // Absence of a verdict must be visible AS absence. If these series simply
      // did not exist, an alert rule referencing them would match nothing and
      // read as "no problem" — and there is deliberately no `healthy` verdict to
      // fall back on.
      const body = await scrape();
      expect(body).toContain('# TYPE breeze_db_pool_health gauge');
      expect(body).toContain('# TYPE breeze_db_connect_timeouts_total counter');
      expect(body).toContain('# TYPE breeze_db_connect_timeout_rate_per_min gauge');

      for (const verdict of DB_POOL_HEALTH_VERDICTS) {
        expect(getMetricLine(body, 'breeze_db_pool_health', { verdict })).toBe(
          `breeze_db_pool_health{verdict="${verdict}"} 0`,
        );
      }
      expect(
        getMetricLine(body, 'breeze_db_pool_health_last_check_timestamp_seconds'),
      ).toBe('breeze_db_pool_health_last_check_timestamp_seconds 0');
    });

    it('tracks the watchdog verdict on scrape', async () => {
      // Deleting the updateDbPoolHealthMetrics() call would otherwise pin every
      // gauge at its initialize-time zero forever — the exact hazard the
      // event-loop suite above exists to prevent for #3022.
      await runDbPoolHealthCheck({
        readStats: () => connectTimeoutStats(40),
        probe: async () => {},
        thresholdTimeouts: 10,
      });

      const body = await scrape();
      expect(getMetricLine(body, 'breeze_db_pool_health', { verdict: 'pool-degraded' })).toBe(
        'breeze_db_pool_health{verdict="pool-degraded"} 1',
      );
      expect(getMetricLine(body, 'breeze_db_pool_health', { verdict: 'below-threshold' })).toBe(
        'breeze_db_pool_health{verdict="below-threshold"} 0',
      );
      expect(
        getMetricLine(body, 'breeze_db_pool_health_last_check_timestamp_seconds'),
      ).not.toBe('breeze_db_pool_health_last_check_timestamp_seconds 0');
    });

    it('CLEARS a degraded verdict once the condition passes', async () => {
      // A stuck `pool-degraded` series would page an operator to restart a
      // healthy API forever.
      await runDbPoolHealthCheck({
        readStats: () => connectTimeoutStats(40),
        probe: async () => {},
        thresholdTimeouts: 10,
      });
      expect(
        getMetricLine(await scrape(), 'breeze_db_pool_health', { verdict: 'pool-degraded' }),
      ).toBe('breeze_db_pool_health{verdict="pool-degraded"} 1');

      await runDbPoolHealthCheck({
        readStats: () => connectTimeoutStats(0),
        probe: async () => {},
        thresholdTimeouts: 10,
      });

      const body = await scrape();
      expect(getMetricLine(body, 'breeze_db_pool_health', { verdict: 'pool-degraded' })).toBe(
        'breeze_db_pool_health{verdict="pool-degraded"} 0',
      );
      expect(getMetricLine(body, 'breeze_db_pool_health', { verdict: 'below-threshold' })).toBe(
        'breeze_db_pool_health{verdict="below-threshold"} 1',
      );
    });

    it('goes back to all-zero — never a stale verdict — when an evaluation fails', async () => {
      await runDbPoolHealthCheck({
        readStats: () => connectTimeoutStats(0),
        probe: async () => {},
        thresholdTimeouts: 10,
      });
      await runDbPoolHealthCheck({
        readStats: () => {
          throw new Error('stats exploded');
        },
      });

      const body = await scrape();
      for (const verdict of DB_POOL_HEALTH_VERDICTS) {
        expect(getMetricLine(body, 'breeze_db_pool_health', { verdict })).toBe(
          `breeze_db_pool_health{verdict="${verdict}"} 0`,
        );
      }
      expect(getMetricLine(body, 'breeze_db_pool_health_check_failures')).toBe(
        'breeze_db_pool_health_check_failures 1',
      );
    });

    it('increments the connect-timeout counter through the recorder binding', async () => {
      // Kills the "delete the setDbConnectTimeoutMetricsRecorder(...) call"
      // mutation: without that binding the counter never leaves its seeded 0
      // while the watchdog and the internal window keep working — a clean chart
      // during an active storm.
      recordDbConnectTimeout(new Error('a'), 'connectivity');
      recordDbConnectTimeout(new Error('b'), 'event-loop-starvation');

      const body = await scrape();
      expect(getMetricLine(body, 'breeze_db_connect_timeouts_total', { cause: 'connectivity' }))
        .toBe('breeze_db_connect_timeouts_total{cause="connectivity"} 1');
      expect(
        getMetricLine(body, 'breeze_db_connect_timeouts_total', { cause: 'event-loop-starvation' }),
      ).toBe('breeze_db_connect_timeouts_total{cause="event-loop-starvation"} 1');
    });
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
    recordHttpRequest('GET', '/api/devices/:id', 200, 0.2);
    recordHttpRequest('GET', '/api/devices/:id', 204, 0.4);

    const res = await app.request('/metrics', {
      headers: { Authorization: 'Bearer token' }
    });
    const body = await res.text();

    // Both requests collapse onto one series: same route template, same class.
    const counterLine = getMetricLine(body, 'http_requests_total', {
      method: 'GET',
      route: '/api/devices/:id',
      status_class: '2xx'
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

  it('buckets responses by class rather than exact status code', async () => {
    recordHttpRequest('POST', '/api/things', 500, 0.1);
    recordHttpRequest('POST', '/api/things', 503, 0.1);
    recordHttpRequest('POST', '/api/things', 404, 0.1);

    const body = await (
      await app.request('/metrics', { headers: { Authorization: 'Bearer token' } })
    ).text();

    expect(
      getMetricLine(body, 'http_requests_total', {
        method: 'POST',
        route: '/api/things',
        status_class: '5xx'
      })?.endsWith(' 2')
    ).toBe(true);
    expect(
      getMetricLine(body, 'http_requests_total', {
        method: 'POST',
        route: '/api/things',
        status_class: '4xx'
      })?.endsWith(' 1')
    ).toBe(true);
    // The exact code must not survive as its own label.
    expect(body).not.toContain('status="503"');
  });

  it('normalizes unknown verbs so a probe cannot open a new series', async () => {
    recordHttpRequest('PROPFIND', '/api/things', 405, 0.01);

    const body = await (
      await app.request('/metrics', { headers: { Authorization: 'Bearer token' } })
    ).text();

    expect(
      getMetricLine(body, 'http_requests_total', {
        method: 'other',
        route: '/api/things',
        status_class: '4xx'
      })
    ).toBeDefined();
    expect(body).not.toContain('PROPFIND');
  });

  // The bug this file exists to prevent a repeat of: the middleware was written
  // and unit-tested, but nothing mounted it, so a production scrape carried no
  // per-request series at all. These assertions only hold when it is wired up.
  describe('metricsMiddleware route labelling', () => {
    function buildApp(): Hono {
      const appWithMiddleware = new Hono();
      appWithMiddleware.use('*', metricsMiddleware);
      appWithMiddleware.use('*', authMiddleware);
      appWithMiddleware.get('/widgets/:id', (c) => c.json({ ok: true }));
      // A non-numeric, non-UUID path parameter: the label the OLD raw-path
      // scrubber would have emitted verbatim.
      appWithMiddleware.get('/orgs/:slug/detail', (c) => c.json({ ok: true }));
      appWithMiddleware.get('/boom', () => {
        throw new Error('handler exploded');
      });
      appWithMiddleware.route('/', metricsRoutes);
      return appWithMiddleware;
    }

    async function scrape(target: Hono): Promise<string> {
      const res = await target.request('/metrics', {
        headers: { Authorization: 'Bearer token' }
      });
      return res.text();
    }

    it('labels a matched request with the Hono route template', async () => {
      const appWithMiddleware = buildApp();
      const res = await appWithMiddleware.request('/widgets/42', {
        headers: { Authorization: 'Bearer token' }
      });
      expect(res.status).toBe(200);

      const body = await scrape(appWithMiddleware);
      expect(
        getMetricLine(body, 'http_requests_total', {
          method: 'GET',
          route: '/widgets/:id',
          status_class: '2xx'
        })?.endsWith(' 1')
      ).toBe(true);
      expect(
        getMetricLine(body, 'http_request_duration_seconds_count', {
          method: 'GET',
          route: '/widgets/:id'
        })?.endsWith(' 1')
      ).toBe(true);
    });

    it('uses the template for a non-numeric path parameter instead of the raw value', async () => {
      const appWithMiddleware = buildApp();
      await appWithMiddleware.request('/orgs/acme-corp/detail', {
        headers: { Authorization: 'Bearer token' }
      });
      await appWithMiddleware.request('/orgs/globex-industries/detail', {
        headers: { Authorization: 'Bearer token' }
      });

      const body = await scrape(appWithMiddleware);
      expect(
        getMetricLine(body, 'http_requests_total', {
          method: 'GET',
          route: '/orgs/:slug/detail',
          status_class: '2xx'
        })?.endsWith(' 2')
      ).toBe(true);
      expect(body).not.toContain('acme-corp');
      expect(body).not.toContain('globex-industries');
    });

    it('collapses unrouted paths onto a single `unmatched` series', async () => {
      const appWithMiddleware = buildApp();
      await appWithMiddleware.request('/wp-admin/setup-config.php', {
        headers: { Authorization: 'Bearer token' }
      });
      await appWithMiddleware.request('/.env', {
        headers: { Authorization: 'Bearer token' }
      });

      const body = await scrape(appWithMiddleware);
      expect(
        getMetricLine(body, 'http_requests_total', {
          method: 'GET',
          route: 'unmatched',
          status_class: '4xx'
        })?.endsWith(' 2')
      ).toBe(true);
      expect(body).not.toContain('wp-admin');
    });

    it('counts a throwing handler as 5xx and releases the in-flight gauge', async () => {
      const appWithMiddleware = buildApp();
      await appWithMiddleware.request('/boom', {
        headers: { Authorization: 'Bearer token' }
      });

      const body = await scrape(appWithMiddleware);
      expect(
        getMetricLine(body, 'http_requests_total', {
          method: 'GET',
          route: '/boom',
          status_class: '5xx'
        })?.endsWith(' 1')
      ).toBe(true);
      // The scrape itself is in flight while it renders, so 1 — never 2, which
      // is what a `finally`-less decrement would leave behind.
      expect(body).toContain('http_requests_in_flight 1');
    });

    it('does not carry an org_id label', async () => {
      const appWithMiddleware = buildApp();
      await appWithMiddleware.request('/widgets/42', {
        headers: { Authorization: 'Bearer token' }
      });

      const body = await scrape(appWithMiddleware);
      const line = body
        .split('\n')
        .find((l) => l.startsWith('http_requests_total{') && l.includes('/widgets/:id'));
      expect(line).toBeDefined();
      expect(line).not.toContain('org_id');
    });
  });

  // `breeze_active_devices` / `breeze_active_organizations` reported 0 in both
  // production regions against a live fleet: they were seeded to 0 and the only
  // setter had no production caller. These tests pin the refresh path AND the db
  // context it runs in — a contextless read on RLS-forced `devices` returns zero
  // rows silently, which would reproduce the original symptom exactly.
  describe('fleet gauges (SOC 2 A1.1)', () => {
    /**
     * Discriminates on the TABLE rather than call order. An order-coupled mock
     * (chained `mockReturnValueOnce`) breaks whenever the two queries are
     * reordered inside one transaction, which is a refactor with no behavioural
     * meaning.
     */
    /**
     * What the readiness half of the pass actually handed to Drizzle: the
     * tables it joined and the predicate it filtered on. Recorded separately
     * from the fleet query's `captured` array so a test can compile the
     * predicate rather than trust a hand-shaped mock result (#3969).
     */
    const readinessQuery: { condition?: unknown; joinedTables: unknown[] } = {
      joinedTables: [],
    };

    function mockFleetQueries(opts: {
      fleet?: Record<string, unknown>;
      readiness?: Record<string, unknown>;
      fleetError?: Error;
    } = {}): any[] {
      const captured: any[] = [];
      readinessQuery.condition = undefined;
      readinessQuery.joinedTables = [];
      selectMock.mockImplementation(() => ({
        from: (table: unknown) => {
          if (table === devices) {
            return {
              where: (condition: any) => {
                captured.push(condition);
                dbContextEvents.push('fleet-query');
                if (opts.fleetError) return Promise.reject(opts.fleetError);
                return Promise.resolve([
                  opts.fleet ?? { devicesActive: 0, organizationsActive: 0 },
                ]);
              },
            };
          }
          const readinessChain: any = {
            innerJoin: (joined: unknown) => {
              readinessQuery.joinedTables.push(joined);
              return readinessChain;
            },
            where: (condition: any) => {
              readinessQuery.condition = condition;
              return Promise.resolve([opts.readiness ?? { count: 0 }]);
            },
          };
          return readinessChain;
        },
      }));
      return captured;
    }

    async function scrape(): Promise<string> {
      const res = await app.request('/metrics', { headers: { Authorization: 'Bearer token' } });
      return res.text();
    }

    it('publishes live device and organization counts on scrape', async () => {
      mockFleetQueries({ fleet: { devicesActive: 4213, organizationsActive: 87 } });

      const body = await scrape();

      expect(getMetricLine(body, 'breeze_active_devices')).toBe('breeze_active_devices 4213');
      expect(getMetricLine(body, 'breeze_active_organizations')).toBe(
        'breeze_active_organizations 87'
      );
    });

    it('refreshes the backup readiness gauge in the same pass', async () => {
      mockFleetQueries({ readiness: { count: 3 } });

      const body = await scrape();

      expect(getMetricLine(body, 'breeze_backup_low_readiness_devices')).toBe(
        'breeze_backup_low_readiness_devices 3'
      );
    });

    // `readFleetGauges` has always DOCUMENTED that ephemeral Quick Support
    // devices and decommissioned records are excluded "the same exclusions
    // `GET /metrics/` applies, so the gauge and the dashboard count the same
    // fleet". That was true of the devices query and never of the readiness
    // query beneath it, which was a bare count over `recovery_readiness` with
    // no join to `devices` at all — so a device decommissioned 16 days earlier
    // kept pinning the BreezeBackupLowReadinessDevices warning on US prod, and
    // the comment actively misled whoever triaged it (#3969).
    //
    // Asserted against the COMPILED SQL, not against the predicate objects: a
    // mock can be taught to return any count we like, and only the text
    // Postgres receives can prove the exclusion is really in the query. The
    // count assertion above passes just as happily with no filter at all.
    describe('backup low-readiness gauge exclusions (#3969)', () => {
      function compiledReadinessPredicate(): string {
        expect(readinessQuery.condition).toBeDefined();
        return new PgDialect().sqlToQuery(readinessQuery.condition as SQL).sql;
      }

      it('joins recovery_readiness to devices so the two can be filtered together', async () => {
        mockFleetQueries({ readiness: { count: 3 } });

        await scrape();

        expect(readinessQuery.joinedTables).toContain(devices);
      });

      it('excludes decommissioned devices from the low-readiness count', async () => {
        mockFleetQueries({ readiness: { count: 3 } });

        await scrape();

        expect(compiledReadinessPredicate()).toMatch(
          /"devices"\."status"\s*(<>|!=)\s*'decommissioned'/
        );
      });

      it('excludes ephemeral Quick Support devices from the low-readiness count', async () => {
        mockFleetQueries({ readiness: { count: 3 } });

        await scrape();

        expect(compiledReadinessPredicate()).toMatch(
          /"devices"\."is_ephemeral"\s*=\s*false/
        );
      });

      // The exclusions must be ADDED to the threshold filter, not replace it —
      // otherwise the gauge counts every readiness row on the fleet.
      it('still filters on the low-readiness threshold', async () => {
        mockFleetQueries({ readiness: { count: 3 } });

        await scrape();

        expect(compiledReadinessPredicate()).toMatch(
          /"recovery_readiness"\."readiness_score"\s*</
        );
      });
    });

    it('coerces string counts from the driver', async () => {
      mockFleetQueries({ fleet: { devicesActive: '12', organizationsActive: '3' } });

      const body = await scrape();

      expect(getMetricLine(body, 'breeze_active_devices')).toBe('breeze_active_devices 12');
    });

    // The predecessor of this test asserted only `toHaveBeenCalled()` on both
    // wrappers — which passed even with the wrapper stripped off the fleet query,
    // because the readiness query called them first. It also could not tell the
    // correct nesting from the inverted one, and inverting it drops the system
    // GUCs and returns zero rows under RLS: the exact original symptom.
    it('runs the fleet query inside runOutsideDbContext → withSystemDbAccessContext', async () => {
      mockFleetQueries();

      await scrape();

      const outside = dbContextEvents.lastIndexOf('outside:enter');
      const system = dbContextEvents.lastIndexOf('system:enter');
      const query = dbContextEvents.lastIndexOf('fleet-query');
      const exit = dbContextEvents.indexOf('system:exit', system);

      expect(outside).toBeGreaterThan(-1);
      expect(query).toBeGreaterThan(-1);
      // Order matters: exit the request context FIRST, then open a system one.
      expect(outside).toBeLessThan(system);
      expect(system).toBeLessThan(query);
      // ...and the query must still be inside that context when it runs.
      expect(query).toBeLessThan(exit);
    });

    it('opens exactly one db context per scrape for both gauges', async () => {
      mockFleetQueries();

      await scrape();

      expect(dbContextEvents.filter((e) => e === 'system:enter')).toHaveLength(1);
    });

    it('excludes ephemeral and decommissioned devices and bounds by last heartbeat', async () => {
      const captured = mockFleetQueries();

      await scrape();

      const condition = captured[0];
      expect(findCondition(condition, 'eq', devices.isEphemeral)?.value).toBe(false);
      const recency = findCondition(condition, 'gte', devices.lastSeenAt);
      expect(recency?.value).toBeInstanceOf(Date);
      // Default window is 300s; allow slack for test execution time.
      const windowMs = Date.now() - (recency.value as Date).getTime();
      expect(windowMs).toBeGreaterThan(290_000);
      expect(windowMs).toBeLessThan(310_000);
    });

    it('honours METRICS_ACTIVE_DEVICE_WINDOW_SECONDS', async () => {
      process.env.METRICS_ACTIVE_DEVICE_WINDOW_SECONDS = '60';
      try {
        const captured = mockFleetQueries();
        await scrape();

        const recency = findCondition(captured[0], 'gte', devices.lastSeenAt);
        const windowMs = Date.now() - (recency.value as Date).getTime();
        expect(windowMs).toBeGreaterThan(50_000);
        expect(windowMs).toBeLessThan(70_000);
      } finally {
        delete process.env.METRICS_ACTIVE_DEVICE_WINDOW_SECONDS;
      }
    });

    // The `> 0` clamp is what stops a misconfigured deploy from turning the TTL
    // into "aggregate on every scrape" or the window into "the fleet is inactive".
    it.each(['0', '-30', 'not-a-number'])(
      'falls back to the default window when the env var is %s',
      async (raw) => {
        process.env.METRICS_ACTIVE_DEVICE_WINDOW_SECONDS = raw;
        try {
          const captured = mockFleetQueries();
          await scrape();

          const recency = findCondition(captured[0], 'gte', devices.lastSeenAt);
          const windowMs = Date.now() - (recency.value as Date).getTime();
          expect(windowMs).toBeGreaterThan(290_000);
          expect(windowMs).toBeLessThan(310_000);
        } finally {
          delete process.env.METRICS_ACTIVE_DEVICE_WINDOW_SECONDS;
        }
      }
    );

    it('caches across back-to-back scrapes so a scrape loop cannot hammer the fleet query', async () => {
      mockFleetQueries({ fleet: { devicesActive: 500, organizationsActive: 9 } });
      await scrape();
      mockFleetQueries({ fleet: { devicesActive: 999, organizationsActive: 99 } });
      const body = await scrape();

      expect(getMetricLine(body, 'breeze_active_devices')).toBe('breeze_active_devices 500');
      expect(dbContextEvents.filter((e) => e === 'fleet-query')).toHaveLength(1);
    });

    // A timestamp alone throttles only scrapes arriving inside the TTL. The
    // aggregate gets slow exactly when the database is unwell, which is when a
    // second scrape would otherwise launch a concurrent full scan.
    it('single-flights concurrent scrapes into one query', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      selectMock.mockImplementation(() => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === devices) {
              dbContextEvents.push('fleet-query');
              return gate.then(() => [{ devicesActive: 7, organizationsActive: 2 }]);
            }
            return Promise.resolve([{ count: 0 }]);
          },
        }),
      }));

      const both = Promise.all([scrape(), scrape()]);
      release();
      await both;

      expect(dbContextEvents.filter((e) => e === 'fleet-query')).toHaveLength(1);
    });

    it('leaves the last known values in place when the query fails', async () => {
      mockFleetQueries({ fleet: { devicesActive: 77, organizationsActive: 2 } });
      await scrape();

      process.env.METRICS_FLEET_GAUGE_TTL_SECONDS = '0.001';
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        mockFleetQueries({ fleetError: new Error('pool exhausted') });

        const body = await scrape();

        // A failed refresh must not silently republish 0 — that is the exact
        // reading that hid this bug for months.
        expect(getMetricLine(body, 'breeze_active_devices')).toBe('breeze_active_devices 77');
        expect(warn).toHaveBeenCalled();
        // ...but the staleness must be VISIBLE rather than merely survivable.
        expect(getMetricLine(body, 'breeze_fleet_gauge_refresh_failures_total')).toBe(
          'breeze_fleet_gauge_refresh_failures_total 1'
        );
      } finally {
        warn.mockRestore();
        delete process.env.METRICS_FLEET_GAUGE_TTL_SECONDS;
      }
    });

    // Without this, a refresh that fails from boot onward publishes a flat 0 with
    // nothing to distinguish it from an empty fleet — the original bug, with a
    // console.warn nobody alerts on.
    it('keeps the freshness timestamp at 0 until a refresh actually succeeds', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        mockFleetQueries({ fleetError: new Error('permission denied for table devices') });

        const body = await scrape();

        expect(getMetricLine(body, 'breeze_fleet_gauges_last_refresh_timestamp_seconds')).toBe(
          'breeze_fleet_gauges_last_refresh_timestamp_seconds 0'
        );
        expect(getMetricLine(body, 'breeze_active_devices')).toBe('breeze_active_devices 0');
      } finally {
        warn.mockRestore();
      }
    });

    it('publishes a freshness timestamp once a refresh succeeds', async () => {
      mockFleetQueries({ fleet: { devicesActive: 5, organizationsActive: 1 } });

      const body = await scrape();

      const line = getMetricLine(body, 'breeze_fleet_gauges_last_refresh_timestamp_seconds');
      const seconds = Number(line?.split(' ').pop());
      expect(seconds).toBeGreaterThan(Date.now() / 1000 - 60);
    });

    // A failed refresh must not burn the whole TTL: the next scrape retries.
    it('retries on the next scrape after a failure', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        mockFleetQueries({ fleetError: new Error('transient') });
        await scrape();

        mockFleetQueries({ fleet: { devicesActive: 31, organizationsActive: 4 } });
        const body = await scrape();

        expect(getMetricLine(body, 'breeze_active_devices')).toBe('breeze_active_devices 31');
      } finally {
        warn.mockRestore();
      }
    });

    // The scrape is the only way to see inside a sick instance. Gating it on a
    // database read means a pool stall takes every unrelated series with it and
    // flips `up` to 0, which reads as a dead API rather than a sick database.
    it('still renders the registry when the fleet query never settles', async () => {
      process.env.METRICS_FLEET_GAUGE_TIMEOUT_SECONDS = '0.05';
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        selectMock.mockImplementation(() => ({
          from: (table: unknown) => ({
            where: () =>
              table === devices ? new Promise(() => {}) : Promise.resolve([{ count: 0 }]),
          }),
        }));

        const body = await scrape();

        expect(body).toContain('http_requests_in_flight');
        expect(getMetricLine(body, 'breeze_fleet_gauge_refresh_failures_total')).toBe(
          'breeze_fleet_gauge_refresh_failures_total 1'
        );
      } finally {
        warn.mockRestore();
        delete process.env.METRICS_FLEET_GAUGE_TIMEOUT_SECONDS;
      }
    });

    // A `count(*)` always returns one row, so no row is a driver anomaly — not an
    // empty fleet. Publishing 0 for it is the misleading reading, not the safe one.
    it('treats a missing result row as a failure rather than an empty fleet', async () => {
      mockFleetQueries({ fleet: { devicesActive: 42, organizationsActive: 8 } });
      await scrape();

      process.env.METRICS_FLEET_GAUGE_TTL_SECONDS = '0.001';
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        selectMock.mockImplementation(() => ({
          from: () => ({ where: () => Promise.resolve([]) }),
        }));

        const body = await scrape();

        expect(getMetricLine(body, 'breeze_active_devices')).toBe('breeze_active_devices 42');
        expect(getMetricLine(body, 'breeze_fleet_gauge_refresh_failures_total')).toBe(
          'breeze_fleet_gauge_refresh_failures_total 1'
        );
      } finally {
        warn.mockRestore();
        delete process.env.METRICS_FLEET_GAUGE_TTL_SECONDS;
      }
    });
  });

  it('aggregates business metrics and counters', async () => {
    // Device/org counts come from the scrape-time refresh, so they are seeded
    // through the mocked query rather than the setter — the setter's values
    // would be overwritten by the refresh that `/json` performs.
    stubFleetGaugeQueries(selectMock, { fleet: { devicesActive: 12, organizationsActive: 3 } });
    updateBusinessMetrics({
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

  // The other half of the `agent_heartbeat_total` fix: the heartbeat route imports
  // `recordAgentHeartbeat` from this module directly, so what this pins is that the
  // counter it increments is the one actually rendered into the scrape.
  it('renders agent heartbeats recorded through the exported counter', async () => {
    recordAgentHeartbeat('success');
    recordAgentHeartbeat('success');
    recordAgentHeartbeat('failed');

    const body = await (
      await app.request('/metrics', { headers: { Authorization: 'Bearer token' } })
    ).text();

    expect(getMetricLine(body, 'agent_heartbeat_total', { status: 'success' })).toBe(
      'agent_heartbeat_total{status="success"} 2'
    );
    expect(getMetricLine(body, 'agent_heartbeat_total', { status: 'failed' })).toBe(
      'agent_heartbeat_total{status="failed"} 1'
    );
  });

  it('keeps the agent-heartbeat counter usable after a metrics reset', async () => {
    resetMetricsForTesting();
    recordAgentHeartbeat('failed');

    const body = await (
      await app.request('/metrics', { headers: { Authorization: 'Bearer token' } })
    ).text();

    expect(getMetricLine(body, 'agent_heartbeat_total', { status: 'failed' })).toBe(
      'agent_heartbeat_total{status="failed"} 1'
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
    stubFleetGaugeQueries(selectMock, { readiness: { count: 3 } });
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
