import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { expectDefaultPageFits } from './aiToolOutputBudget.testkit';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

// aiToolsPerformance.ts reaches the queue through the mandatory-origin
// adapter; none of these tests exercise analyze_boot_performance's collection
// trigger or manage_startup_items, so a bare stub keeps the (much heavier)
// real commandQueue/dispatchDeviceCommand/scriptDispatch import graph out of
// this suite.
vi.mock('./aiDispatch', () => ({
  aiExecuteCommand: vi.fn(),
}));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerPerformanceTools } from './aiToolsPerformance';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
/** Same org, same site as DEVICE — only the exact-device allowlist separates them. */
const SIBLING_DEVICE_ID = '33333333-3333-4333-8333-333333333333';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function createChain(result: unknown = []) {
  const chain: Record<string, any> = {};
  // `as` is the subquery terminator (`.groupBy(...).as('per_device')`) —
  // analyze_fleet_metrics builds one and reuses it for both of its queries.
  for (const method of ['from', 'where', 'groupBy', 'orderBy', 'limit', 'innerJoin', 'as']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return chain;
}

function mockSelectOnce(result: unknown) {
  mockDb.select.mockImplementationOnce(() => createChain(result));
}

function captureSingleWhere(result: unknown = []) {
  let captured: unknown;
  mockDb.select.mockImplementationOnce(() => {
    const chain = createChain(result);
    chain.where = vi.fn((condition: unknown) => {
      captured = condition;
      return chain;
    });
    return chain;
  });
  return { capturedWhere: () => captured };
}

/**
 * analyze_fleet_metrics issues THREE `db.select()` calls, in this order:
 *   1. the grouped per-device subquery builder (`.groupBy(...).as(...)`) —
 *      never awaited on its own, but it is the call that carries the WHERE
 *      tree, so site/org condition assertions hook here;
 *   2. the ranked top-N page selected FROM that subquery;
 *   3. the single-row fleet summary aggregated FROM the same subquery.
 *
 * The per-device fold and the fleet summary both happen in SQL now, so the
 * fixtures below are already-grouped rows (one per device), not raw buckets.
 */
function mockFleetMetricsQueries(
  topRows: unknown[],
  fleetRow: Record<string, unknown> | null = null,
): { capturedWhere: () => unknown } {
  let captured: unknown;
  mockDb.select.mockImplementationOnce(() => {
    const chain = createChain([]);
    chain.where = vi.fn((condition: unknown) => {
      captured = condition;
      return chain;
    });
    return chain;
  });
  mockSelectOnce(topRows);
  mockSelectOnce(fleetRow ? [fleetRow] : []);
  return { capturedWhere: () => captured };
}

/** One already-grouped per-device row, as the GROUP BY now returns it. */
function groupedDeviceRow(
  deviceId: string,
  hostname: string,
  agg: { weightedAvgSum: number | string; totalSamples: number | string; maxValue: number | null; peakP95: number | null },
) {
  return { deviceId, hostname, ...agg };
}

function handlerFor(name: string): AiTool['handler'] {
  const registry = new Map<string, AiTool>();
  registerPerformanceTools(registry);
  return registry.get(name)!.handler;
}

function makeAuth(): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    canAccessSite: () => true,
  } as AuthContext;
}

const DEVICE = {
  id: DEVICE_ID,
  orgId: ORG_ID,
  siteId: 'site-1',
  hostname: 'host-1',
  status: 'online',
};

function rawMetric(timestamp: string, cpuPercent: number) {
  return {
    timestamp: new Date(timestamp),
    cpuPercent,
    ramPercent: 50,
    diskPercent: 60,
    ramUsedMb: 1024,
    diskUsedGb: 200,
  };
}

describe('analyze_metrics AI tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses metric rollups for hourly analysis when available', async () => {
    mockSelectOnce([DEVICE]);
    mockSelectOnce([
      {
        timestamp: new Date('2026-06-18T11:00:00.000Z'),
        cpuPercent: 42.125,
        ramPercent: 55.5,
        ramUsedMb: 2048,
        diskPercent: 70.75,
        diskUsedGb: 250,
        sampleCount: 12,
      },
      {
        timestamp: new Date('2026-06-18T10:00:00.000Z'),
        cpuPercent: 21,
        ramPercent: 40,
        ramUsedMb: 1024,
        diskPercent: 65,
        diskUsedGb: 240,
        sampleCount: 11,
      },
    ]);

    const result = await handlerFor('analyze_metrics')(
      { deviceId: DEVICE_ID, hoursBack: 72, aggregation: 'hourly' },
      makeAuth()
    );
    const parsed = JSON.parse(result);

    expect(parsed.source).toBe('metric_rollups');
    expect(parsed.summary.dataPoints).toBe(23);
    expect(parsed.summary.cpu.current).toBe(42.125);
    expect(parsed.buckets).toEqual([
      { period: '2026-06-18T11:00', cpu: 42.13, ram: 55.5, disk: 70.75, count: 12 },
      { period: '2026-06-18T10:00', cpu: 21, ram: 40, disk: 65, count: 11 },
    ]);
    expect(mockDb.select).toHaveBeenCalledTimes(2);
  });

  it('falls back to raw device metrics when hourly rollups are empty', async () => {
    mockSelectOnce([DEVICE]);
    mockSelectOnce([]);
    mockSelectOnce([
      rawMetric('2026-06-18T11:30:00.000Z', 40),
      rawMetric('2026-06-18T11:00:00.000Z', 20),
    ]);

    const result = await handlerFor('analyze_metrics')(
      { deviceId: DEVICE_ID, hoursBack: 72, aggregation: 'hourly' },
      makeAuth()
    );
    const parsed = JSON.parse(result);

    expect(parsed.source).toBe('device_metrics');
    expect(parsed.summary.dataPoints).toBe(2);
    expect(parsed.buckets).toEqual([
      { period: '2026-06-18T11:00', cpu: 30, ram: 50, disk: 60, count: 2 },
    ]);
    expect(mockDb.select).toHaveBeenCalledTimes(3);
  });

  it('keeps raw analysis on raw device metrics', async () => {
    mockSelectOnce([DEVICE]);
    mockSelectOnce([
      rawMetric('2026-06-18T11:30:00.000Z', 40),
      rawMetric('2026-06-18T11:00:00.000Z', 20),
    ]);

    const result = await handlerFor('analyze_metrics')(
      { deviceId: DEVICE_ID, hoursBack: 2, aggregation: 'raw' },
      makeAuth()
    );
    const parsed = JSON.parse(result);

    expect(parsed.metrics).toHaveLength(2);
    expect(parsed.summary.cpu.current).toBe(40);
    expect(parsed.source).toBeUndefined();
    expect(mockDb.select).toHaveBeenCalledTimes(2);
  });

  // #6096 D5a. An agent run's auth pins BOTH axes: the run device's site and
  // the run device itself. The site pin alone admits every sibling in that
  // site, so the exact-device allowlist is the boundary that actually holds —
  // and it must hold BEFORE the device read, not after.
  describe('exact-device allowlist', () => {
    function boundAuth(): AuthContext {
      return {
        ...makeAuth(),
        allowedSiteIds: ['site-1'],
        canAccessSite: () => true,
        allowedDeviceIds: [DEVICE_ID],
      } as AuthContext;
    }

    it('denies a same-site sibling device without reading it', async () => {
      const result = await handlerFor('analyze_metrics')(
        { deviceId: SIBLING_DEVICE_ID, hoursBack: 2, aggregation: 'raw' },
        boundAuth()
      );

      expect(JSON.parse(result).error).toMatch(/not found or access denied/i);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('proceeds for the run device itself', async () => {
      mockSelectOnce([DEVICE]);
      mockSelectOnce([rawMetric('2026-06-18T11:30:00.000Z', 40)]);

      const result = await handlerFor('analyze_metrics')(
        { deviceId: DEVICE_ID, hoursBack: 2, aggregation: 'raw' },
        boundAuth()
      );

      expect(JSON.parse(result).error).toBeUndefined();
      expect(mockDb.select).toHaveBeenCalledTimes(2);
    });
  });
});

describe('analyze_fleet_metrics AI tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function authWith(overrides: Partial<AuthContext> = {}): AuthContext {
    return { ...makeAuth(), ...overrides } as AuthContext;
  }

  it('rejects an unknown metricName without querying the db, and advertises the real rollup names', async () => {
    const result = await handlerFor('analyze_fleet_metrics')({ metricName: 'memory_percent' }, makeAuth());
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain('Invalid metricName');
    // The task brief's "memory_percent" isn't a real rollup name — the tool
    // must advertise the actual column, ram_percent.
    expect(parsed.error).toContain('ram_percent');
    expect(parsed.error).not.toContain('memory_percent,');
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('denies an inaccessible orgId without querying the db', async () => {
    const restrictedAuth = authWith({ canAccessOrg: () => false });
    const result = await handlerFor('analyze_fleet_metrics')(
      { metricName: 'cpu_percent', orgId: 'org-other' },
      restrictedAuth
    );
    const parsed = JSON.parse(result);

    expect(parsed.error).toBe('Access to this organization denied');
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('defaults to a 24h window, topN 10, and the 5-minute bucket tier', async () => {
    mockFleetMetricsQueries([]);
    const result = await handlerFor('analyze_fleet_metrics')({ metricName: 'cpu_percent' }, makeAuth());
    const parsed = JSON.parse(result);

    expect(parsed.windowHours).toBe(24);
    expect(parsed.topN).toBe(10);
    expect(parsed.bucketSeconds).toBe(300);
  });

  it('clamps windowHours to 168 and topN to 50, switching to the hourly bucket tier above 24h', async () => {
    mockFleetMetricsQueries([]);
    const result = await handlerFor('analyze_fleet_metrics')(
      { metricName: 'cpu_percent', windowHours: 9999, topN: 9999 },
      makeAuth()
    );
    const parsed = JSON.parse(result);

    expect(parsed.windowHours).toBe(168);
    expect(parsed.topN).toBe(50);
    expect(parsed.bucketSeconds).toBe(3600);
  });

  it('treats a negative windowHours/topN as invalid input and floors to 1 (matches analyze_metrics convention: 0/falsy falls back to the default)', async () => {
    mockFleetMetricsQueries([]);
    const result = await handlerFor('analyze_fleet_metrics')(
      { metricName: 'cpu_percent', windowHours: -5, topN: -5 },
      makeAuth()
    );
    const parsed = JSON.parse(result);

    expect(parsed.windowHours).toBe(1);
    expect(parsed.topN).toBe(1);
  });

  it('renders per-device avg from the SQL-weighted sum and ranks by peak p95 desc', async () => {
    // Already-grouped rows: d1's two buckets (avg 40 x 10 samples, avg 60 x 10)
    // were folded by SUM(avg_value * sample_count) = 1000 over 20 samples.
    mockFleetMetricsQueries(
      [
        groupedDeviceRow('d1', 'host-1', { weightedAvgSum: 1000, totalSamples: 20, maxValue: 90, peakP95: 85 }),
        groupedDeviceRow('d2', 'host-2', { weightedAvgSum: 50, totalSamples: 5, maxValue: 20, peakP95: 15 }),
      ],
      { deviceCount: 2, weightedAvgSum: 1050, totalSamples: 25, maxValue: 90, avgPeakP95: 50 },
    );

    const result = await handlerFor('analyze_fleet_metrics')({ metricName: 'cpu_percent' }, makeAuth());
    const parsed = JSON.parse(result);

    expect(parsed.deviceCount).toBe(2);
    expect(parsed.topDevices[0]).toEqual({
      deviceId: 'd1', hostname: 'host-1', avg: 50, p95: 85, max: 90, sampleCount: 20,
    });
    expect(parsed.topDevices[1].deviceId).toBe('d2');
    expect(parsed.fleetSummary.max).toBe(90);
    expect(parsed.fleetSummary.sampleCount).toBe(25);
    expect(parsed.fleetSummary.avg).toBe(42);
    // Fleet-level p95 is an explicitly-approximate figure (average of each
    // device's peak p95: (85+15)/2 = 50) — named accordingly so a model
    // consuming this output can't mistake it for a true fleet-wide
    // percentile. Must NOT be exposed under a bare `p95` key.
    expect(parsed.fleetSummary.p95ApproxAvgOfDevicePeaks).toBe(50);
    expect(parsed.fleetSummary).not.toHaveProperty('p95');
  });

  it('coerces bigint/numeric aggregates returned as strings (SUM(integer), COUNT(*), AVG)', async () => {
    // postgres.js hands back int8/numeric as strings; arithmetic on those
    // concatenates instead of adding, so the tool must coerce.
    mockFleetMetricsQueries(
      [groupedDeviceRow('d1', 'host-1', { weightedAvgSum: '1000', totalSamples: '20', maxValue: 90, peakP95: 85 })],
      { deviceCount: '1', weightedAvgSum: '1000', totalSamples: '20', maxValue: 90, avgPeakP95: '85' },
    );

    const parsed = JSON.parse(
      await handlerFor('analyze_fleet_metrics')({ metricName: 'cpu_percent' }, makeAuth())
    );

    expect(parsed.deviceCount).toBe(1);
    expect(parsed.topDevices[0].avg).toBe(50);
    expect(parsed.topDevices[0].sampleCount).toBe(20);
    expect(parsed.fleetSummary.avg).toBe(50);
    expect(parsed.fleetSummary.sampleCount).toBe(20);
  });

  it('pushes the fold into SQL: GROUP BY device, ORDER BY peak p95 DESC NULLS LAST, LIMIT topN', async () => {
    const chains: Array<Record<string, any>> = [];
    mockDb.select.mockImplementation(() => {
      const chain = createChain([]);
      chains.push(chain);
      return chain;
    });

    await handlerFor('analyze_fleet_metrics')({ metricName: 'cpu_percent', topN: 7 }, makeAuth());

    // Chain 0 = the grouped subquery builder; chain 1 = the ranked page.
    const [builder, page] = chains;
    expect(builder!.groupBy).toHaveBeenCalledTimes(1);
    expect(builder!.as).toHaveBeenCalledWith('per_device');
    expect(page!.limit).toHaveBeenCalledWith(7);

    const rendered = new PgDialect().sqlToQuery(page!.orderBy.mock.calls[0]![0] as SQL);
    expect(rendered.sql).toContain('DESC NULLS LAST');
  });

  it('discloses the fleet p95 approximation in the tool description (not just a source comment)', () => {
    const registry = new Map<string, AiTool>();
    registerPerformanceTools(registry);
    const description = registry.get('analyze_fleet_metrics')!.definition.description!;

    expect(description).toContain('p95ApproxAvgOfDevicePeaks');
    expect(description.toLowerCase()).toContain('approximation');
  });

  it('reports the full deviceCount from the fleet aggregate, not the length of the topN page', async () => {
    // The LIMIT is applied in SQL, so the page really is only topN rows —
    // deviceCount must come from the separate COUNT(*) over every grouped row
    // or the tool would under-report the fleet on every truncated result.
    mockFleetMetricsQueries(
      [
        groupedDeviceRow('d4', 'host-4', { weightedAvgSum: 4, totalSamples: 1, maxValue: 4, peakP95: 4 }),
        groupedDeviceRow('d3', 'host-3', { weightedAvgSum: 3, totalSamples: 1, maxValue: 3, peakP95: 3 }),
      ],
      { deviceCount: 5, weightedAvgSum: 10, totalSamples: 5, maxValue: 4, avgPeakP95: 2 },
    );

    const result = await handlerFor('analyze_fleet_metrics')(
      { metricName: 'cpu_percent', topN: 2 },
      makeAuth()
    );
    const parsed = JSON.parse(result);

    expect(parsed.topDevices).toHaveLength(2);
    expect(parsed.deviceCount).toBe(5);
    expect(parsed.topDevices.map((d: { deviceId: string }) => d.deviceId)).toEqual(['d4', 'd3']);
  });

  it('returns nulls (not NaN) for a fleet summary row of all NULLs — no rollups in window', async () => {
    mockFleetMetricsQueries(
      [],
      { deviceCount: 0, weightedAvgSum: null, totalSamples: null, maxValue: null, avgPeakP95: null },
    );

    const parsed = JSON.parse(
      await handlerFor('analyze_fleet_metrics')({ metricName: 'cpu_percent' }, makeAuth())
    );

    expect(parsed.deviceCount).toBe(0);
    expect(parsed.topDevices).toEqual([]);
    expect(parsed.fleetSummary).toEqual({
      avg: null, p95ApproxAvgOfDevicePeaks: null, max: null, sampleCount: 0,
    });
  });

  it('short-circuits for a zero-site restricted caller without querying the db', async () => {
    const restrictedAuth = authWith({ allowedSiteIds: [], canAccessSite: () => false });
    const result = await handlerFor('analyze_fleet_metrics')({ metricName: 'cpu_percent' }, restrictedAuth);
    const parsed = JSON.parse(result);

    expect(parsed.deviceCount).toBe(0);
    expect(parsed.topDevices).toEqual([]);
    expect(typeof parsed.note).toBe('string');
    expect(parsed.fleetSummary.p95ApproxAvgOfDevicePeaks).toBeNull();
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('adds a devices.siteId inArray condition to the query for a site-restricted caller', async () => {
    const { capturedWhere } = mockFleetMetricsQueries([]);

    const restrictedAuth = authWith({ allowedSiteIds: ['site-A'], canAccessSite: (s) => s === 'site-A' });
    await handlerFor('analyze_fleet_metrics')({ metricName: 'cpu_percent' }, restrictedAuth);

    const condition = capturedWhere() as SQL | undefined;
    expect(condition).toBeDefined();
    const rendered = new PgDialect().sqlToQuery(condition!);
    expect(rendered.params).toContain('site-A');
  });

  it('does not add a site condition for an unrestricted caller (no regression)', async () => {
    const { capturedWhere } = mockFleetMetricsQueries([]);

    await handlerFor('analyze_fleet_metrics')({ metricName: 'cpu_percent' }, makeAuth());

    const condition = capturedWhere() as SQL | undefined;
    expect(condition).toBeDefined();
    const rendered = new PgDialect().sqlToQuery(condition!);
    expect(rendered.params).not.toContain('site-A');
  });
});

describe('fleet user-session AI tools — site narrowing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function restrictedAuth(allowedSiteIds: string[] | null): AuthContext {
    return {
      ...makeAuth(),
      allowedSiteIds,
      canAccessSite: (siteId: string | null | undefined) => Array.isArray(allowedSiteIds)
        && !!siteId
        && allowedSiteIds.includes(siteId),
    } as unknown as AuthContext;
  }

  it.each([
    ['get_active_users', { limit: 1 }],
    ['get_user_experience_metrics', { limit: 1 }],
  ])('%s returns an empty result for a defined-empty site ceiling without querying', async (tool, input) => {
    const parsed = JSON.parse(await handlerFor(tool)(input, restrictedAuth([])));

    expect(parsed.totalActiveSessions ?? parsed.totalSessions).toBe(0);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it.each([
    ['get_active_users', { limit: 1 }],
    ['get_user_experience_metrics', { limit: 1 }],
  ])('%s pushes the current device site ceiling into SQL before LIMIT', async (tool, input) => {
    const { capturedWhere } = captureSingleWhere([]);

    await handlerFor(tool)(input, restrictedAuth(['site-A']));

    const condition = capturedWhere() as SQL | undefined;
    expect(condition).toBeDefined();
    const rendered = new PgDialect().sqlToQuery(condition!);
    expect(rendered.params).toContain('site-A');
  });

  it.each([
    ['get_active_users', { limit: 1 }],
    ['get_user_experience_metrics', { limit: 1 }],
  ])('%s remains unrestricted when no site ceiling exists', async (tool, input) => {
    const { capturedWhere } = captureSingleWhere([]);

    await handlerFor(tool)(input, makeAuth());

    const rendered = new PgDialect().sqlToQuery(capturedWhere() as SQL);
    expect(rendered.params).not.toContain('site-A');
  });
});

describe('get_active_users — limit caps devices, not sessions (A-W05 5c)', () => {
  beforeEach(() => vi.clearAllMocks());

  function sessionRow(deviceId: string, hostname: string, i: number) {
    return {
      sessionId: `sess-${deviceId}-${i}`, deviceId, hostname, deviceStatus: 'online',
      username: `user${i}`, sessionType: 'rdp', osSessionId: String(i), loginAt: new Date(),
      idleMinutes: 0, activityState: 'active', loginPerformanceSeconds: 1, lastActivityAt: new Date(),
    };
  }

  it('caps sessions per device at maxSessionsPerDevice and reports sessionCount', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => sessionRow(DEVICE_ID, 'host-1', i));
    mockSelectOnce(rows);

    const out = JSON.parse(await handlerFor('get_active_users')({ maxSessionsPerDevice: 5 }, makeAuth()));
    expect(out.devices).toHaveLength(1);
    expect(out.devices[0].sessions).toHaveLength(5);
    expect(out.devices[0].sessionCount).toBe(20);
    expect(out.devices[0].activeSessionCount).toBe(20);
  });

  it('caps devices at `limit` and reports deviceCount/showing/hasMore', async () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => sessionRow(DEVICE_ID, 'host-1', i)),
      ...Array.from({ length: 3 }, (_, i) => sessionRow(SIBLING_DEVICE_ID, 'host-2', i)),
    ];
    mockSelectOnce(rows);

    const out = JSON.parse(await handlerFor('get_active_users')({ limit: 1 }, makeAuth()));
    expect(out.devices).toHaveLength(1);
    expect(out.showing).toBe(1);
    expect(out.deviceCount).toBe(2);
    expect(out.limit).toBe(1);
    expect(out.hasMore).toBe(true);
  });

  it('a default page of realistic sessions (one per device) fits the chat budget uncompacted', async () => {
    const deviceIds = Array.from({ length: 12 }, (_, d) => `44444444-4444-4444-4444-${String(d).padStart(12, '0')}`);
    const rows = deviceIds.map((id, d) => sessionRow(id, `host-${d}`, 0));
    mockSelectOnce(rows);

    const raw = await handlerFor('get_active_users')({}, makeAuth());
    const out = JSON.parse(raw) as Record<string, unknown>;
    expect(out.limit).toBe(12);
    expect(out.deviceCount).toBe(12);
    expectDefaultPageFits('get_active_users', raw);
  });

  it('a worst-case fleet (more devices than the default page) degrades honestly: hasMore/limit survive compaction or digest', async () => {
    const deviceIds = Array.from({ length: 200 }, (_, d) => `55555555-5555-5555-5555-${String(d).padStart(12, '0')}`);
    const rows = deviceIds.flatMap((id, d) => Array.from({ length: 3 }, (_, i) => sessionRow(id, `host-${d}`, i)));
    mockSelectOnce(rows);

    const raw = await handlerFor('get_active_users')({ limit: 200 }, makeAuth());
    const { compactToolResultForChat } = await import('./aiToolOutput');
    const compacted = JSON.parse(compactToolResultForChat('get_active_users', raw)) as { hasMore?: boolean; limit?: number; summarized?: boolean };
    // Whether it lands as a compacted-but-intact payload or a digest, the
    // paging envelope must still tell the model how to keep going.
    expect(compacted.limit).toBe(200);
    expect(typeof compacted.hasMore).toBe('boolean');
  });
});
