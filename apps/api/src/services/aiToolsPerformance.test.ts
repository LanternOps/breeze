import { beforeEach, describe, expect, it, vi } from 'vitest';

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
