import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {}
}));

import { reliabilityScoringInternals } from './reliabilityScoring';

function makeBucket(overrides: Record<string, unknown>) {
  return {
    date: '2026-02-20',
    sampleCount: 1,
    uptimeSecondsMax: 3600,
    crashCount: 0,
    hangCount: 0,
    unresolvedHangCount: 0,
    serviceFailureCount: 0,
    recoveredServiceCount: 0,
    hardwareErrorCount: 0,
    hardwareCriticalCount: 0,
    hardwareErrorSeverityCount: 0,
    hardwareWarningCount: 0,
    ...overrides,
  };
}

function makeHistoryRow(overrides: Record<string, unknown>) {
  return {
    id: 'history-1',
    deviceId: 'device-1',
    orgId: 'org-1',
    collectedAt: new Date('2026-02-20T10:00:00.000Z'),
    uptimeSeconds: 600,
    bootTime: new Date('2026-02-20T09:50:00.000Z'),
    crashEvents: [],
    appHangs: [],
    serviceFailures: [],
    hardwareErrors: [],
    rawMetrics: {},
    ...overrides,
  };
}

describe('reliabilityScoringInternals', () => {
  it('merges multiple history rows into the same daily bucket', () => {
    const rows = [
      makeHistoryRow({
        crashEvents: [{ timestamp: '2026-02-20T10:01:00.000Z' }],
        appHangs: [{ timestamp: '2026-02-20T10:02:00.000Z', resolved: false }],
      }),
      makeHistoryRow({
        collectedAt: new Date('2026-02-20T12:00:00.000Z'),
        uptimeSeconds: 1200,
        crashEvents: [{ timestamp: '2026-02-20T12:01:00.000Z' }],
        serviceFailures: [{ timestamp: '2026-02-20T12:05:00.000Z', recovered: true }],
        hardwareErrors: [{ timestamp: '2026-02-20T12:10:00.000Z', severity: 'critical' }],
      }),
    ] as any[];

    const map = new Map<string, any>();
    reliabilityScoringInternals.mergeRowsIntoDailyBuckets(map, rows as any);
    const [bucket] = reliabilityScoringInternals.sortDailyBuckets(map);

    expect(bucket.sampleCount).toBe(2);
    expect(bucket.uptimeSecondsMax).toBe(1200);
    expect(bucket.crashCount).toBe(2);
    expect(bucket.hangCount).toBe(1);
    expect(bucket.unresolvedHangCount).toBe(1);
    expect(bucket.serviceFailureCount).toBe(1);
    expect(bucket.recoveredServiceCount).toBe(1);
    expect(bucket.hardwareCriticalCount).toBe(1);
    expect(bucket.lastCrashAt).toBe('2026-02-20T12:01:00.000Z');
  });

  it('builds trend points only for observed days (no default-100 gaps)', () => {
    const now = new Date('2026-02-21T00:00:00.000Z');
    const buckets = [
      makeBucket({ date: '2026-02-01', crashCount: 0 }),
      makeBucket({ date: '2026-02-10', crashCount: 1 }),
      makeBucket({ date: '2026-02-20', crashCount: 4 }),
    ] as any[];

    const points = reliabilityScoringInternals.buildDailyTrendPoints(buckets, 30, now);
    expect(points).toHaveLength(3);

    const trend = reliabilityScoringInternals.computeTrend(buckets, now);
    expect(trend.direction).toBe('degrading');
    expect(trend.confidence).toBeGreaterThan(0);
  });

  it('computes MTBF from aggregated failures and uptime window', () => {
    const now = new Date('2026-02-21T00:00:00.000Z');
    const latest = {
      collectedAt: now,
      uptimeSeconds: 90 * 24 * 3600,
      bootTime: new Date('2025-11-23T00:00:00.000Z'),
    };
    const buckets = [makeBucket({ date: '2026-02-20', crashCount: 9 })] as any[];

    const mtbfHours = reliabilityScoringInternals.computeMtbfHours(buckets, latest as any, now);
    expect(mtbfHours).toBe(240);
  });

  it('parses stored aggregate state and prunes out-of-window buckets', () => {
    const now = new Date('2026-02-21T00:00:00.000Z');
    const state = reliabilityScoringInternals.parseAggregateState({
      aggregates: {
        lastProcessedAt: '2026-02-20T23:59:00.000Z',
        dailyBuckets: [
          makeBucket({ date: '2025-10-01', crashCount: 5 }),
          makeBucket({ date: '2026-02-20', crashCount: 1 }),
        ],
      },
    } as any, now);

    expect(state?.lastProcessedAt?.toISOString()).toBe('2026-02-20T23:59:00.000Z');
    expect(state?.dailyBuckets.size).toBe(1);
    expect(state?.dailyBuckets.has('2026-02-20')).toBe(true);
  });
});
