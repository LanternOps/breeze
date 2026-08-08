import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerPerformanceTools } from './aiToolsPerformance';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function createChain(result: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'groupBy', 'orderBy', 'limit', 'innerJoin']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return chain;
}

function mockSelectOnce(result: unknown) {
  mockDb.select.mockImplementationOnce(() => createChain(result));
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
    mockSelectOnce([]);
    const result = await handlerFor('analyze_fleet_metrics')({ metricName: 'cpu_percent' }, makeAuth());
    const parsed = JSON.parse(result);

    expect(parsed.windowHours).toBe(24);
    expect(parsed.topN).toBe(10);
    expect(parsed.bucketSeconds).toBe(300);
  });

  it('clamps windowHours to 168 and topN to 50, switching to the hourly bucket tier above 24h', async () => {
    mockSelectOnce([]);
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
    mockSelectOnce([]);
    const result = await handlerFor('analyze_fleet_metrics')(
      { metricName: 'cpu_percent', windowHours: -5, topN: -5 },
      makeAuth()
    );
    const parsed = JSON.parse(result);

    expect(parsed.windowHours).toBe(1);
    expect(parsed.topN).toBe(1);
  });

  it('aggregates per-device avg (weighted)/peak-p95 (max)/max across buckets and ranks by peak p95 desc', async () => {
    mockSelectOnce([
      { deviceId: 'd1', hostname: 'host-1', avgValue: 40, maxValue: 60, p95Value: 55, sampleCount: 10 },
      { deviceId: 'd1', hostname: 'host-1', avgValue: 60, maxValue: 90, p95Value: 85, sampleCount: 10 },
      { deviceId: 'd2', hostname: 'host-2', avgValue: 10, maxValue: 20, p95Value: 15, sampleCount: 5 },
    ]);

    const result = await handlerFor('analyze_fleet_metrics')({ metricName: 'cpu_percent' }, makeAuth());
    const parsed = JSON.parse(result);

    expect(parsed.deviceCount).toBe(2);
    expect(parsed.topDevices[0]).toEqual({
      deviceId: 'd1', hostname: 'host-1', avg: 50, p95: 85, max: 90, sampleCount: 20,
    });
    expect(parsed.topDevices[1].deviceId).toBe('d2');
    expect(parsed.fleetSummary.max).toBe(90);
    expect(parsed.fleetSummary.sampleCount).toBe(25);
  });

  it('caps topDevices at topN while still reporting the full deviceCount', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      deviceId: `d${i}`, hostname: `host-${i}`, avgValue: i, maxValue: i, p95Value: i, sampleCount: 1,
    }));
    mockSelectOnce(rows);

    const result = await handlerFor('analyze_fleet_metrics')(
      { metricName: 'cpu_percent', topN: 2 },
      makeAuth()
    );
    const parsed = JSON.parse(result);

    expect(parsed.topDevices).toHaveLength(2);
    expect(parsed.deviceCount).toBe(5);
    // Ranked by p95 desc: d4 (p95=4), d3 (p95=3)
    expect(parsed.topDevices.map((d: { deviceId: string }) => d.deviceId)).toEqual(['d4', 'd3']);
  });

  it('short-circuits for a zero-site restricted caller without querying the db', async () => {
    const restrictedAuth = authWith({ allowedSiteIds: [], canAccessSite: () => false });
    const result = await handlerFor('analyze_fleet_metrics')({ metricName: 'cpu_percent' }, restrictedAuth);
    const parsed = JSON.parse(result);

    expect(parsed.deviceCount).toBe(0);
    expect(parsed.topDevices).toEqual([]);
    expect(typeof parsed.note).toBe('string');
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('adds a devices.siteId inArray condition to the query for a site-restricted caller', async () => {
    let capturedCondition: SQL | undefined;
    mockDb.select.mockImplementationOnce(() => {
      const chain: Record<string, any> = {};
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      chain.where = (condition: SQL) => {
        capturedCondition = condition;
        return chain;
      };
      chain.then = (onFulfilled?: (value: unknown) => unknown) => Promise.resolve([]).then(onFulfilled);
      return chain;
    });

    const restrictedAuth = authWith({ allowedSiteIds: ['site-A'], canAccessSite: (s) => s === 'site-A' });
    await handlerFor('analyze_fleet_metrics')({ metricName: 'cpu_percent' }, restrictedAuth);

    expect(capturedCondition).toBeDefined();
    const rendered = new PgDialect().sqlToQuery(capturedCondition!);
    expect(rendered.params).toContain('site-A');
  });

  it('does not add a site condition for an unrestricted caller (no regression)', async () => {
    let capturedCondition: SQL | undefined;
    mockDb.select.mockImplementationOnce(() => {
      const chain: Record<string, any> = {};
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      chain.where = (condition: SQL) => {
        capturedCondition = condition;
        return chain;
      };
      chain.then = (onFulfilled?: (value: unknown) => unknown) => Promise.resolve([]).then(onFulfilled);
      return chain;
    });

    await handlerFor('analyze_fleet_metrics')({ metricName: 'cpu_percent' }, makeAuth());

    expect(capturedCondition).toBeDefined();
    const rendered = new PgDialect().sqlToQuery(capturedCondition!);
    expect(rendered.params).not.toContain('site-A');
  });
});
