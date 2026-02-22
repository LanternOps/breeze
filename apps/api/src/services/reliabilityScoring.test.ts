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
    expect(bucket).toBeDefined();

    expect(bucket!.sampleCount).toBe(2);
    expect(bucket!.uptimeSecondsMax).toBe(1200);
    expect(bucket!.crashCount).toBe(2);
    expect(bucket!.hangCount).toBe(1);
    expect(bucket!.unresolvedHangCount).toBe(1);
    expect(bucket!.serviceFailureCount).toBe(1);
    expect(bucket!.recoveredServiceCount).toBe(1);
    expect(bucket!.hardwareCriticalCount).toBe(1);
    expect(bucket!.lastCrashAt).toBe('2026-02-20T12:01:00.000Z');
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

describe('scoreUptime', () => {
  const { scoreUptime } = reliabilityScoringInternals;

  it('returns 100 at 100% uptime', () => expect(scoreUptime(100)).toBe(100));
  it('returns 0 at exactly 90% uptime (cliff boundary)', () => expect(scoreUptime(90)).toBe(0));
  it('returns 0 below 90% uptime', () => expect(scoreUptime(89)).toBe(0));
  it('returns 0 at 0%', () => expect(scoreUptime(0)).toBe(0));
  it('returns 50 at 95% uptime (midpoint of linear range)', () => expect(scoreUptime(95)).toBe(50));
});

describe('scoreCrashes', () => {
  const { scoreCrashes } = reliabilityScoringInternals;

  it('returns 100 with no crashes', () => expect(scoreCrashes(0, 0)).toBe(100));
  it('reduces score proportionally', () => expect(scoreCrashes(0, 1)).toBe(80));
  it('applies 0.5x weight to 7d crashes', () => expect(scoreCrashes(2, 0)).toBe(80));
  it('clamps to 0 with many crashes', () => expect(scoreCrashes(10, 10)).toBe(0));
});

describe('scoreHangs', () => {
  const { scoreHangs } = reliabilityScoringInternals;

  it('returns 100 with no hangs', () => expect(scoreHangs(0, 0)).toBe(100));
  it('unresolved hangs carry 2x penalty vs resolved', () => {
    const oneResolved = scoreHangs(1, 0);
    const oneUnresolved = scoreHangs(1, 1);
    expect(oneResolved).toBe(90);
    expect(oneUnresolved).toBe(70);
  });
  it('clamps to 0', () => expect(scoreHangs(20, 20)).toBe(0));
});

describe('scoreServiceFailures', () => {
  const { scoreServiceFailures } = reliabilityScoringInternals;

  it('returns 100 with no failures', () => expect(scoreServiceFailures(0, 0)).toBe(100));
  it('recovered services add 5 points each', () => expect(scoreServiceFailures(1, 1)).toBe(90));
  it('clamps to 0 with many failures', () => expect(scoreServiceFailures(10, 0)).toBe(0));
  it('clamps to 100 even with many recoveries', () => expect(scoreServiceFailures(0, 10)).toBe(100));
});

describe('scoreHardwareErrors', () => {
  const { scoreHardwareErrors } = reliabilityScoringInternals;

  it('returns 100 with no errors', () => expect(scoreHardwareErrors(0, 0, 0)).toBe(100));
  it('one critical error removes 30 points', () => expect(scoreHardwareErrors(1, 0, 0)).toBe(70));
  it('one error severity removes 15 points', () => expect(scoreHardwareErrors(0, 1, 0)).toBe(85));
  it('one warning removes 5 points', () => expect(scoreHardwareErrors(0, 0, 1)).toBe(95));
  it('clamps to 0 with 4+ critical errors', () => expect(scoreHardwareErrors(4, 0, 0)).toBe(0));
});

describe('scoreBand', () => {
  const { scoreBand } = reliabilityScoringInternals;

  it('returns critical at 50', () => expect(scoreBand(50)).toBe('critical'));
  it('returns poor at 51', () => expect(scoreBand(51)).toBe('poor'));
  it('returns poor at 70', () => expect(scoreBand(70)).toBe('poor'));
  it('returns fair at 71', () => expect(scoreBand(71)).toBe('fair'));
  it('returns fair at 85', () => expect(scoreBand(85)).toBe('fair'));
  it('returns good at 86', () => expect(scoreBand(86)).toBe('good'));
  it('returns good at 100', () => expect(scoreBand(100)).toBe('good'));
});

describe('computeTopIssues', () => {
  const { computeTopIssues } = reliabilityScoringInternals;
  const now = new Date('2026-02-20T00:00:00.000Z');

  it('returns empty array when all counts are zero', () => {
    const issues = computeTopIssues({
      dailyBuckets: [],
      now,
      uptime30d: 100,
      crashCount30d: 0,
      hangCount30d: 0,
      serviceFailureCount30d: 0,
      hardwareErrorCount30d: 0,
      criticalHardwareCount30d: 0,
    });
    expect(issues).toHaveLength(0);
  });

  it('sets crash severity to critical at 3+ crashes', () => {
    const issues = computeTopIssues({
      dailyBuckets: [],
      now,
      uptime30d: 100,
      crashCount30d: 3,
      hangCount30d: 0,
      serviceFailureCount30d: 0,
      hardwareErrorCount30d: 0,
      criticalHardwareCount30d: 0,
    });
    const crashes = issues.find((i) => i.type === 'crashes');
    expect(crashes?.severity).toBe('critical');
  });

  it('caps result to 5 issues', () => {
    const issues = computeTopIssues({
      dailyBuckets: [],
      now,
      uptime30d: 80,
      crashCount30d: 5,
      hangCount30d: 5,
      serviceFailureCount30d: 5,
      hardwareErrorCount30d: 5,
      criticalHardwareCount30d: 2,
    });
    expect(issues.length).toBeLessThanOrEqual(5);
  });
});
