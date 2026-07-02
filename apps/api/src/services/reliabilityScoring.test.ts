import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {}
}));

import { reliabilityScoringInternals } from './reliabilityScoring';

function makeBucket(overrides: Record<string, unknown>) {
  return {
    date: '2026-02-20',
    sampleCount: 1,
    uptimeSecondsMax: 3600,
    crashCount: 0,
    appCrashCount: 0,
    hangCount: 0,
    unresolvedHangCount: 0,
    serviceFailureCount: 0,
    recoveredServiceCount: 0,
    selfServiceFailureCount: 0,
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
        hardwareErrors: [{ timestamp: '2026-02-20T12:10:00.000Z', severity: 'critical', type: 'disk', source: 'disk' }],
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
    // Issue #1908: scoreDailyBucket sums per-factor lost points (full 0–100 range),
    // so a worsening fault load over time produces a clearly negative slope.
    const buckets = [
      makeBucket({ date: '2026-02-01', crashCount: 0, serviceFailureCount: 0, hangCount: 0 }),
      makeBucket({ date: '2026-02-10', crashCount: 2, serviceFailureCount: 2, hangCount: 1 }),
      makeBucket({ date: '2026-02-20', crashCount: 5, serviceFailureCount: 5, hangCount: 3, hardwareCriticalCount: 1 }),
    ] as any[];

    const points = reliabilityScoringInternals.buildDailyTrendPoints(buckets, 30, now);
    expect(points).toHaveLength(3);

    const trend = reliabilityScoringInternals.computeTrend(buckets, now);
    expect(trend.direction).toBe('degrading');
    expect(trend.confidence).toBeGreaterThan(0);
  });

  it('detects an improving trend when faults decrease over time', () => {
    const now = new Date('2026-02-21T00:00:00.000Z');
    const buckets = [
      makeBucket({ date: '2026-02-01', crashCount: 5, serviceFailureCount: 5, hangCount: 3, hardwareCriticalCount: 1 }),
      makeBucket({ date: '2026-02-10', crashCount: 2, serviceFailureCount: 2, hangCount: 1 }),
      makeBucket({ date: '2026-02-20', crashCount: 0, serviceFailureCount: 0, hangCount: 0 }),
    ] as any[];

    const trend = reliabilityScoringInternals.computeTrend(buckets, now);
    expect(trend.direction).toBe('improving');
  });

  it('reads a shallow single-factor change as stable (slope within ±2)', () => {
    // One crash on the final observed day only → day scores 100, 100, 72 over a
    // 20-day span → slope ≈ -1.4, inside the ±2 deadband → stable, not degrading.
    // Locks the trend threshold against the gentler curve over-triggering.
    const now = new Date('2026-02-21T00:00:00.000Z');
    const buckets = [
      makeBucket({ date: '2026-02-01' }),
      makeBucket({ date: '2026-02-10' }),
      makeBucket({ date: '2026-02-20', crashCount: 1 }),
    ] as any[];

    const trend = reliabilityScoringInternals.computeTrend(buckets, now);
    expect(trend.direction).toBe('stable');
  });

  it('computes MTBF from aggregated failures and observed up-days', () => {
    const now = new Date('2026-02-21T00:00:00.000Z');
    // 90 observed up-days (operating hours = 90*24 = 2160) and 9 failures → 240h.
    const buckets = [makeBucket({ date: '2026-02-20', crashCount: 9 })] as any[];

    const mtbfHours = reliabilityScoringInternals.computeMtbfHours(buckets, 90, now);
    expect(mtbfHours).toBe(240);
  });

  it('returns null MTBF when there are no observed up-days', () => {
    const now = new Date('2026-02-21T00:00:00.000Z');
    const buckets = [makeBucket({ date: '2026-02-20', crashCount: 9 })] as any[];
    expect(reliabilityScoringInternals.computeMtbfHours(buckets, 0, now)).toBeNull();
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

// Issue #1908: rate-normalization denominator = observed up-days in window.
describe('countObservedUpDaysInWindow', () => {
  const { countObservedUpDaysInWindow, sortDailyBuckets } = reliabilityScoringInternals;
  const now = new Date('2026-06-26T12:00:00.000Z');
  const day = (offsetDays: number) =>
    new Date(now.getTime() - offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Minimal buckets: only date + sampleCount matter for this helper.
  const buckets = sortDailyBuckets(
    new Map(
      [
        { date: day(1), sampleCount: 3 },   // in 30d window, reported
        { date: day(5), sampleCount: 1 },   // in 30d window, reported
        { date: day(10), sampleCount: 0 },  // in window but NO sample → excluded
        { date: day(40), sampleCount: 9 },  // outside 30d window → excluded
      ].map((b) => [b.date, b as any]),
    ),
  );

  it('counts only in-window buckets that have at least one sample', () => {
    expect(countObservedUpDaysInWindow(buckets, 30, now)).toBe(2);
  });

  it('shrinks the window correctly', () => {
    expect(countObservedUpDaysInWindow(buckets, 3, now)).toBe(1); // only day(1)
  });
});

// Issue #1904: reliability is POSTed many times/day, each re-reading an
// overlapping last-50-events window, so the SAME event lands verbatim in
// multiple history rows. mergeRowsIntoDailyBuckets must count each DISTINCT
// event exactly once across the WHOLE window (not sum array lengths per row,
// and not dedup only within a single day bucket).
describe('mergeRowsIntoDailyBuckets event dedup (#1904)', () => {
  const { mergeRowsIntoDailyBuckets, sortDailyBuckets, sumBucketsInWindow } = reliabilityScoringInternals;

  function totalCount(map: Map<string, any>, getter: (bucket: any) => number): number {
    return sortDailyBuckets(map).reduce((sum, bucket) => sum + getter(bucket), 0);
  }

  it('counts the same service-failure event present in N overlapping rows exactly once', () => {
    const failure = {
      serviceName: 'Service Control Manager',
      timestamp: '2026-02-20T06:59:39.315Z',
      errorCode: '7000:abc',
      recovered: false,
    };
    // Five separate posts, each re-grabbing the identical event (the prod case:
    // one event byte-identical in 5 history rows).
    const rows = [0, 1, 2, 3, 4].map((i) =>
      makeHistoryRow({
        id: `history-${i}`,
        collectedAt: new Date(`2026-02-20T0${i}:00:00.000Z`),
        serviceFailures: [{ ...failure }],
      })
    ) as any[];

    const map = new Map<string, any>();
    mergeRowsIntoDailyBuckets(map, rows as any);

    expect(totalCount(map, (b) => b.serviceFailureCount)).toBe(1);
  });

  it('counts genuinely-distinct events fully (no over-dedup)', () => {
    const rows = [
      makeHistoryRow({
        serviceFailures: [
          { serviceName: 'Spooler', timestamp: '2026-02-20T10:00:00.000Z', errorCode: '7000', recovered: false },
          { serviceName: 'Spooler', timestamp: '2026-02-20T11:00:00.000Z', errorCode: '7000', recovered: false }, // diff time
          { serviceName: 'W32Time', timestamp: '2026-02-20T10:00:00.000Z', errorCode: '7000', recovered: true }, // diff name
          { serviceName: 'Spooler', timestamp: '2026-02-20T10:00:00.000Z', errorCode: '7031', recovered: false }, // diff code
        ],
      }),
    ] as any[];

    const map = new Map<string, any>();
    mergeRowsIntoDailyBuckets(map, rows as any);

    expect(totalCount(map, (b) => b.serviceFailureCount)).toBe(4);
    expect(totalCount(map, (b) => b.recoveredServiceCount)).toBe(1);
  });

  it('dedups an event re-reported in rows on opposite sides of a day boundary', () => {
    // Event at 23:30 on the 20th, re-reported by a row collected on the 21st.
    const hwError = {
      type: 'disk',
      severity: 'critical',
      timestamp: '2026-02-20T23:30:00.000Z',
      source: 'disk',
      eventId: '7',
    };
    const rows = [
      makeHistoryRow({
        id: 'row-day1',
        collectedAt: new Date('2026-02-20T23:45:00.000Z'),
        hardwareErrors: [{ ...hwError }],
      }),
      makeHistoryRow({
        id: 'row-day2',
        collectedAt: new Date('2026-02-21T00:15:00.000Z'),
        hardwareErrors: [{ ...hwError }],
      }),
    ] as any[];

    const map = new Map<string, any>();
    mergeRowsIntoDailyBuckets(map, rows as any);

    // Counted once, in the event's own-timestamp day (the 20th), despite being
    // reported by rows collected on two different calendar days.
    expect(totalCount(map, (b) => b.hardwareErrorCount)).toBe(1);
    expect(totalCount(map, (b) => b.hardwareCriticalCount)).toBe(1);
    const day20 = sortDailyBuckets(map).find((b) => b.date === '2026-02-20');
    expect(day20?.hardwareErrorCount).toBe(1);
    // lastXAt is recorded against the event's own timestamp/day, not the row's.
    expect(day20?.lastHardwareErrorAt).toBe('2026-02-20T23:30:00.000Z');
  });

  it('derives hardware severity sub-counts from the deduped set, not double-summed', () => {
    const critical = { type: 'mce', severity: 'critical', timestamp: '2026-02-20T10:00:00.000Z', source: 'cpu', eventId: '1' };
    const warning = { type: 'disk', severity: 'warning', timestamp: '2026-02-20T11:00:00.000Z', source: 'disk', eventId: '2' };
    // critical reported in 3 rows, warning in 2 rows.
    const rows = [
      makeHistoryRow({ id: 'r1', collectedAt: new Date('2026-02-20T10:05:00.000Z'), hardwareErrors: [{ ...critical }] }),
      makeHistoryRow({ id: 'r2', collectedAt: new Date('2026-02-20T11:05:00.000Z'), hardwareErrors: [{ ...critical }, { ...warning }] }),
      makeHistoryRow({ id: 'r3', collectedAt: new Date('2026-02-20T12:05:00.000Z'), hardwareErrors: [{ ...critical }, { ...warning }] }),
    ] as any[];

    const map = new Map<string, any>();
    mergeRowsIntoDailyBuckets(map, rows as any);

    expect(totalCount(map, (b) => b.hardwareErrorCount)).toBe(2);
    expect(totalCount(map, (b) => b.hardwareCriticalCount)).toBe(1);
    expect(totalCount(map, (b) => b.hardwareWarningCount)).toBe(1);
    expect(totalCount(map, (b) => b.hardwareErrorSeverityCount)).toBe(0);
  });

  it('derives unresolved-hang and recovered-service sub-counts from the deduped set', () => {
    const hang = { processName: 'chrome.exe', timestamp: '2026-02-20T10:00:00.000Z', duration: 5000, resolved: false };
    const recovered = { serviceName: 'Spooler', timestamp: '2026-02-20T10:00:00.000Z', errorCode: '7000', recovered: true };
    const rows = [
      makeHistoryRow({ id: 'r1', appHangs: [{ ...hang }], serviceFailures: [{ ...recovered }] }),
      makeHistoryRow({ id: 'r2', appHangs: [{ ...hang }], serviceFailures: [{ ...recovered }] }), // dup
    ] as any[];

    const map = new Map<string, any>();
    mergeRowsIntoDailyBuckets(map, rows as any);

    expect(totalCount(map, (b) => b.hangCount)).toBe(1);
    expect(totalCount(map, (b) => b.unresolvedHangCount)).toBe(1);
    expect(totalCount(map, (b) => b.serviceFailureCount)).toBe(1);
    expect(totalCount(map, (b) => b.recoveredServiceCount)).toBe(1);
  });

  it('does not regress crash counting (distinct crashes counted, dups collapsed)', () => {
    const crashA = { type: 'bsod', timestamp: '2026-02-20T10:00:00.000Z' };
    const crashB = { type: 'kernel_panic', timestamp: '2026-02-21T10:00:00.000Z' };
    const rows = [
      makeHistoryRow({ id: 'r1', collectedAt: new Date('2026-02-20T10:30:00.000Z'), crashEvents: [{ ...crashA }] }),
      makeHistoryRow({ id: 'r2', collectedAt: new Date('2026-02-21T10:30:00.000Z'), crashEvents: [{ ...crashA }, { ...crashB }] }), // crashA dup
    ] as any[];

    const map = new Map<string, any>();
    mergeRowsIntoDailyBuckets(map, rows as any);

    expect(totalCount(map, (b) => b.crashCount)).toBe(2);
  });

  it('keeps two distinct events with all-empty structured keys separate via JSON fallback', () => {
    // No type/timestamp — only distinguishable by a non-keyed field. JSON
    // fallback must keep them as two events. Uses crashEvents because the
    // hardware factor now drops events with no genuine fault source/type.
    const rows = [
      makeHistoryRow({
        crashEvents: [
          { type: '', details: { a: 1 } },
          { type: '', details: { a: 2 } },
        ],
      }),
    ] as any[];

    const map = new Map<string, any>();
    mergeRowsIntoDailyBuckets(map, rows as any);

    expect(totalCount(map, (b) => b.crashCount)).toBe(2);
  });

  it('drops hardware events that are not genuine hardware faults (old-agent junk)', () => {
    // v0.84.0 and earlier mis-tagged SCM / DCOM / IOKit-plugin events as
    // hardware. They carry no fault type and a non-hardware source, so the
    // server-side gate must exclude them while keeping real faults.
    const rows = [
      makeHistoryRow({
        hardwareErrors: [
          { type: 'unknown', severity: 'error', source: 'service control manager', eventId: '7000', timestamp: '2026-02-20T10:00:00.000Z' },
          { type: 'unknown', severity: 'error', source: 'microsoft-windows-distributedcom', eventId: '10010', timestamp: '2026-02-20T10:01:00.000Z' },
          { type: 'unknown', severity: 'error', source: 'com.apple.iokit.cfplugin', eventId: 'x', timestamp: '2026-02-20T10:02:00.000Z' },
          { type: 'disk', severity: 'critical', source: 'nvme', eventId: '7', timestamp: '2026-02-20T10:03:00.000Z' },
        ],
      }),
    ] as any[];

    const map = new Map<string, any>();
    mergeRowsIntoDailyBuckets(map, rows as any);

    // Only the genuine nvme/disk fault survives.
    expect(totalCount(map, (b) => b.hardwareErrorCount)).toBe(1);
    expect(totalCount(map, (b) => b.hardwareCriticalCount)).toBe(1);
  });

  it('isGenuineHardwareError: only real fault types or known hardware sources pass', () => {
    const { isGenuineHardwareError } = reliabilityScoringInternals;
    // Empty / no-type / non-hardware-source events are dropped.
    expect(isGenuineHardwareError({} as any)).toBe(false);
    expect(isGenuineHardwareError({ source: '', type: '' } as any)).toBe(false);
    expect(isGenuineHardwareError({ source: 'service control manager', type: 'unknown' } as any)).toBe(false);
    // Genuine: a known hardware source, or a real fault subtype (incl. thermal).
    expect(isGenuineHardwareError({ source: 'nvme', type: 'unknown' } as any)).toBe(true);
    expect(isGenuineHardwareError({ source: 'com.apple.kernel', type: 'thermal' } as any)).toBe(true);
  });

  it('isGenuineHardwareError: bare-ID memory/disk stamps need a hardware source', () => {
    const { isGenuineHardwareError } = reliabilityScoringInternals;
    // Agents ≤0.85.x classified ANY event with ID 13/50/51 as "memory" (7/11/15
    // as "disk"). VSS — software — logs event 13; its stamp must not count.
    expect(isGenuineHardwareError({ source: 'VSS', type: 'memory', eventId: '13:135' } as any)).toBe(false);
    expect(isGenuineHardwareError({ source: 'SomeAppProvider', type: 'disk', eventId: '7:2' } as any)).toBe(false);
    // The same bare IDs from a genuine hardware provider still count.
    expect(isGenuineHardwareError({ source: 'disk', type: 'disk', eventId: '11:5' } as any)).toBe(true);
    expect(isGenuineHardwareError({ source: 'Microsoft-Windows-Ntfs', type: 'memory', eventId: '50:9' } as any)).toBe(true);
    // Message-derived stamps carry non-bare IDs and pass on the type alone.
    expect(isGenuineHardwareError({ source: 'SomeAppProvider', type: 'memory', eventId: '9001:3' } as any)).toBe(true);
    expect(isGenuineHardwareError({ source: 'kernel', type: 'disk', eventId: undefined } as any)).toBe(true);
    // mce/thermal stamps are never ID-derived — trusted regardless of source.
    expect(isGenuineHardwareError({ source: 'anything', type: 'mce', eventId: '13:1' } as any)).toBe(true);
  });

  it('drops VSS event-13 memory stamps at the bucket chokepoint', () => {
    const rows = [
      makeHistoryRow({
        hardwareErrors: [
          { type: 'memory', severity: 'error', source: 'VSS', eventId: '13:135', timestamp: '2026-02-20T10:00:00.000Z' },
          { type: 'memory', severity: 'error', source: 'VSS', eventId: '13:132', timestamp: '2026-02-20T10:01:00.000Z' },
          { type: 'memory', severity: 'error', source: 'Microsoft-Windows-WHEA-Logger', eventId: '47:1', timestamp: '2026-02-20T10:02:00.000Z' },
        ],
      }),
    ] as any[];

    const map = new Map<string, any>();
    mergeRowsIntoDailyBuckets(map, rows as any);

    // Only the WHEA memory fault survives the gate.
    expect(totalCount(map, (b) => b.hardwareErrorCount)).toBe(1);
  });

  it('tracks Breeze self service failures as a subset of serviceFailureCount', () => {
    const rows = [
      makeHistoryRow({
        serviceFailures: [
          { serviceName: 'Breeze Agent', timestamp: '2026-02-20T10:00:00.000Z', errorCode: '7031:1', recovered: false },
          { serviceName: 'breeze-watchdog', timestamp: '2026-02-20T10:01:00.000Z', errorCode: '7034:2', recovered: false },
          { serviceName: 'Print Spooler', timestamp: '2026-02-20T10:02:00.000Z', errorCode: '7000:3', recovered: false },
        ],
      }),
    ] as any[];

    const map = new Map<string, any>();
    mergeRowsIntoDailyBuckets(map, rows as any);

    // The headline tile still counts everything; the score-side subset marks ours.
    expect(totalCount(map, (b) => b.serviceFailureCount)).toBe(3);
    expect(totalCount(map, (b) => b.selfServiceFailureCount)).toBe(2);
  });

  it('isBreezeSelfServiceFailure matches our services across platforms, not customer services', () => {
    const { isBreezeSelfServiceFailure } = reliabilityScoringInternals;
    expect(isBreezeSelfServiceFailure('Breeze Agent')).toBe(true);
    expect(isBreezeSelfServiceFailure('breeze-agent')).toBe(true);
    expect(isBreezeSelfServiceFailure('Breeze Watchdog')).toBe(true);
    expect(isBreezeSelfServiceFailure('breeze-helper')).toBe(true);
    expect(isBreezeSelfServiceFailure('Print Spooler')).toBe(false);
    // "breeze" alone isn't enough — a customer service could share the word.
    expect(isBreezeSelfServiceFailure('BreezeWorks Sync')).toBe(false);
    expect(isBreezeSelfServiceFailure(undefined)).toBe(false);
    expect(isBreezeSelfServiceFailure('')).toBe(false);
  });

  it('tracks app_crash as a downweighted subset of crashCount', () => {
    const rows = [
      makeHistoryRow({
        crashEvents: [
          { type: 'app_crash', timestamp: '2026-02-20T10:00:00.000Z' },
          { type: 'app_crash', timestamp: '2026-02-20T11:00:00.000Z' },
          { type: 'bsod', timestamp: '2026-02-20T12:00:00.000Z' },
        ],
      }),
    ] as any[];

    const map = new Map<string, any>();
    mergeRowsIntoDailyBuckets(map, rows as any);

    // All three show in the raw crash count (headline tile); two are app crashes.
    expect(totalCount(map, (b) => b.crashCount)).toBe(3);
    expect(totalCount(map, (b) => b.appCrashCount)).toBe(2);

    // The effective crash load downweights the two app crashes to 0.25 each:
    // 3 - 2*(1-0.25) = 1.5, strictly less than the raw 3.
    const { effectiveCrashLoad, RELIABILITY_APP_CRASH_WEIGHT } = reliabilityScoringInternals;
    expect(effectiveCrashLoad(3, 2)).toBeCloseTo(3 - 2 * (1 - RELIABILITY_APP_CRASH_WEIGHT));
    expect(effectiveCrashLoad(3, 2)).toBeLessThan(3);
    // A real device crash (BSOD) is never downweighted.
    expect(effectiveCrashLoad(1, 0)).toBe(1);
  });

  it('matches a count(DISTINCT ...) over a window with heavy overlap (inflation guard)', () => {
    // Simulate the prod pattern: 1 distinct event reported across 4 rows, plus
    // 3 other distinct events. Summed lengths would be 7; distinct is 4.
    const dup = { serviceName: 'SCM', timestamp: '2026-02-20T06:59:39.315Z', errorCode: '7000:x', recovered: false };
    const rows = [
      makeHistoryRow({ id: 'r1', collectedAt: new Date('2026-02-20T07:00:00.000Z'), serviceFailures: [{ ...dup }, { serviceName: 'A', timestamp: '2026-02-20T01:00:00.000Z', errorCode: '1', recovered: false }] }),
      makeHistoryRow({ id: 'r2', collectedAt: new Date('2026-02-20T08:00:00.000Z'), serviceFailures: [{ ...dup }, { serviceName: 'B', timestamp: '2026-02-20T02:00:00.000Z', errorCode: '2', recovered: false }] }),
      makeHistoryRow({ id: 'r3', collectedAt: new Date('2026-02-20T09:00:00.000Z'), serviceFailures: [{ ...dup }, { serviceName: 'C', timestamp: '2026-02-20T03:00:00.000Z', errorCode: '3', recovered: false }] }),
      makeHistoryRow({ id: 'r4', collectedAt: new Date('2026-02-20T10:00:00.000Z'), serviceFailures: [{ ...dup }] }),
    ] as any[];

    const map = new Map<string, any>();
    mergeRowsIntoDailyBuckets(map, rows as any);
    const now = new Date('2026-02-21T00:00:00.000Z');

    // Summed array lengths = 7; distinct = 4.
    expect(sumBucketsInWindow(sortDailyBuckets(map), 30, now, (b) => b.serviceFailureCount)).toBe(4);
  });

  it('buckets a timestamp-less event by the row collectedAt day and still dedups it', () => {
    // Real agent payloads can omit `timestamp`; eventDayKey then falls back to
    // the row's collectedAt day. The same timestamp-less event re-reported in a
    // later row must still count once (JSON-fallback key), bucketed by the
    // FIRST-seen row's day.
    const noTs = { serviceName: 'Spooler', errorCode: '7000', recovered: false };
    const rows = [
      makeHistoryRow({ id: 'r1', collectedAt: new Date('2026-02-20T05:00:00.000Z'), serviceFailures: [{ ...noTs }] }),
      makeHistoryRow({ id: 'r2', collectedAt: new Date('2026-02-21T05:00:00.000Z'), serviceFailures: [{ ...noTs }] }),
    ] as any[];

    const map = new Map<string, any>();
    mergeRowsIntoDailyBuckets(map, rows as any);

    expect(totalCount(map, (b) => b.serviceFailureCount)).toBe(1);
    const day20 = sortDailyBuckets(map).find((b) => b.date === '2026-02-20');
    expect(day20?.serviceFailureCount).toBe(1);
    // Two genuinely-distinct timestamp-less events in the same row stay separate.
    const two = new Map<string, any>();
    mergeRowsIntoDailyBuckets(two, [
      makeHistoryRow({
        serviceFailures: [
          { serviceName: 'Spooler', errorCode: '7000', recovered: false },
          { serviceName: 'W32Time', errorCode: '7000', recovered: false },
        ],
      }),
    ] as any[]);
    expect(totalCount(two, (b) => b.serviceFailureCount)).toBe(2);
  });

  it('advances lastXAt to the newest occurrence even when later rows are deduped', () => {
    // Same service event re-reported; a later distinct event in the same family
    // carries a newer timestamp. lastServiceFailureAt must track the newest.
    const rows = [
      makeHistoryRow({
        id: 'r1',
        collectedAt: new Date('2026-02-20T07:00:00.000Z'),
        serviceFailures: [{ serviceName: 'SCM', timestamp: '2026-02-20T06:00:00.000Z', errorCode: '1', recovered: false }],
      }),
      makeHistoryRow({
        id: 'r2',
        collectedAt: new Date('2026-02-20T09:00:00.000Z'),
        serviceFailures: [
          { serviceName: 'SCM', timestamp: '2026-02-20T06:00:00.000Z', errorCode: '1', recovered: false }, // dup of r1
          { serviceName: 'SCM', timestamp: '2026-02-20T08:00:00.000Z', errorCode: '1', recovered: false }, // newer, distinct
        ],
      }),
    ] as any[];

    const map = new Map<string, any>();
    mergeRowsIntoDailyBuckets(map, rows as any);

    expect(totalCount(map, (b) => b.serviceFailureCount)).toBe(2);
    const day20 = sortDailyBuckets(map).find((b) => b.date === '2026-02-20');
    expect(day20?.lastServiceFailureAt).toBe('2026-02-20T08:00:00.000Z');
  });

  it('is first-seen-wins for status flags (flipped resolved/recovered re-report does not re-count)', () => {
    // A hang detected then later resolved, and a service failure failed then
    // recovered. Status fields are intentionally NOT part of the dedup key, so
    // the event counts once and its sub-count reflects the first-seen status.
    // Pins the contract so a future key change can't silently flip it.
    const rows = [
      makeHistoryRow({
        id: 'r1',
        collectedAt: new Date('2026-02-20T07:00:00.000Z'),
        appHangs: [{ processName: 'chrome.exe', timestamp: '2026-02-20T06:00:00.000Z', duration: 5000, resolved: false }],
        serviceFailures: [{ serviceName: 'SCM', timestamp: '2026-02-20T06:00:00.000Z', errorCode: '1', recovered: false }],
      }),
      makeHistoryRow({
        id: 'r2',
        collectedAt: new Date('2026-02-20T09:00:00.000Z'),
        appHangs: [{ processName: 'chrome.exe', timestamp: '2026-02-20T06:00:00.000Z', duration: 5000, resolved: true }],
        serviceFailures: [{ serviceName: 'SCM', timestamp: '2026-02-20T06:00:00.000Z', errorCode: '1', recovered: true }],
      }),
    ] as any[];

    const map = new Map<string, any>();
    mergeRowsIntoDailyBuckets(map, rows as any);

    expect(totalCount(map, (b) => b.hangCount)).toBe(1);
    expect(totalCount(map, (b) => b.unresolvedHangCount)).toBe(1); // first-seen: unresolved
    expect(totalCount(map, (b) => b.serviceFailureCount)).toBe(1);
    expect(totalCount(map, (b) => b.recoveredServiceCount)).toBe(0); // first-seen: not recovered
  });

  it('is idempotent across repeated full-window passes (cache-removal guarantee)', () => {
    // computeAndPersistDeviceReliability now rebuilds from the full raw window
    // every run. Running the merge twice over the same rows (each with its own
    // fresh seenKeys, as the orchestrator does) must yield identical counts —
    // i.e. no per-call mutation of the input rows.
    const rows = [
      makeHistoryRow({ id: 'r1', collectedAt: new Date('2026-02-20T07:00:00.000Z'), serviceFailures: [{ serviceName: 'SCM', timestamp: '2026-02-20T06:00:00.000Z', errorCode: '1', recovered: false }] }),
      makeHistoryRow({ id: 'r2', collectedAt: new Date('2026-02-20T08:00:00.000Z'), serviceFailures: [{ serviceName: 'SCM', timestamp: '2026-02-20T06:00:00.000Z', errorCode: '1', recovered: false }] }),
    ] as any[];

    const first = new Map<string, any>();
    mergeRowsIntoDailyBuckets(first, rows as any);
    const second = new Map<string, any>();
    mergeRowsIntoDailyBuckets(second, rows as any);

    expect(totalCount(first, (b) => b.serviceFailureCount)).toBe(1);
    expect(totalCount(second, (b) => b.serviceFailureCount)).toBe(
      totalCount(first, (b) => b.serviceFailureCount)
    );
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

describe('computeUptimePercent', () => {
  const { computeUptimePercent } = reliabilityScoringInternals;
  const now = new Date('2026-02-20T00:00:00.000Z');
  const DAY = 24 * 60 * 60;
  const NONE = new Set<string>(); // no observed-online days (no reliability buckets)

  function makeLatest(uptimeSeconds: number, bootOffsetSeconds: number) {
    return {
      collectedAt: now,
      uptimeSeconds,
      // bootTime = now - bootOffsetSeconds
      bootTime: new Date(now.getTime() - bootOffsetSeconds * 1000),
    };
  }

  // Day-keys (UTC) for the `now - n*DAY` calendar days, used to build the
  // "observed online" set for the established-device cases.
  function dayKeyOffset(daysAgo: number): string {
    return new Date(now.getTime() - daysAgo * DAY * 1000).toISOString().slice(0, 10);
  }

  it('returns 100 with no history snapshot', () => {
    expect(computeUptimePercent(null, NONE, 90, now)).toBe(100);
    expect(computeUptimePercent(null, NONE, 90, now, new Date(now.getTime() - 2 * DAY * 1000))).toBe(100);
  });

  it('penalizes a young device against the full window when enrollment is ignored', () => {
    // Device booted 2 days ago, no observed history, no enrollment clamp: only
    // the 3 calendar days covered by the current boot span count as up, against
    // a 91-day window ≈ 3.3%.
    const latest = makeLatest(2 * DAY, 2 * DAY);
    expect(computeUptimePercent(latest, NONE, 90, now)).toBeCloseTo((3 / 91) * 100, 1);
  });

  it('clamps the window to enrollment so a 2-day-old all-up device scores 100%', () => {
    // Enrolled 2 days ago, booted at enrollment, up the whole time → 100%.
    const enrolledAt = new Date(now.getTime() - 2 * DAY * 1000);
    const latest = makeLatest(2 * DAY, 2 * DAY);
    expect(computeUptimePercent(latest, NONE, 90, now, enrolledAt)).toBe(100);
    expect(computeUptimePercent(latest, NONE, 30, now, enrolledAt)).toBe(100);
  });

  it('counts unobserved days within a young device lifetime as downtime', () => {
    // Enrolled 4 days ago, booted 2 days ago, and NO reliability samples for the
    // 2 pre-reboot days → only the 3 boot-covered calendar days count as up over
    // the 5-day clamped window = 60%. (Had it been reporting those days, they'd
    // be in `observedDays` and it would score ~100 — see the reboot case below.)
    const enrolledAt = new Date(now.getTime() - 4 * DAY * 1000);
    const latest = makeLatest(2 * DAY, 2 * DAY);
    expect(computeUptimePercent(latest, NONE, 90, now, enrolledAt)).toBe(60);
  });

  it('does NOT crater uptime for an established device that merely rebooted (the core fix)', () => {
    // Enrolled 200 days ago, reported reliability every day for the last 90 days,
    // but rebooted 5 days ago (current boot span only covers ~5 days). Under the
    // old boot-snapshot model this scored ~5/90 ≈ 5.6%. With day-coverage, every
    // day has an observed sample, so it is ~100%.
    const enrolledAt = new Date(now.getTime() - 200 * DAY * 1000);
    const latest = makeLatest(5 * DAY, 5 * DAY); // booted 5 days ago
    const observed = new Set<string>();
    for (let d = 0; d <= 90; d += 1) observed.add(dayKeyOffset(d));
    expect(computeUptimePercent(latest, observed, 90, now, enrolledAt)).toBe(100);
  });

  it('reflects real offline gaps for an established device', () => {
    // Enrolled long ago, booted 5 days ago, but only reported on 81 of the 91
    // window days (offline ~10 days) → ~81 up-days + the boot span, ≈ 89%.
    const enrolledAt = new Date(now.getTime() - 200 * DAY * 1000);
    const latest = makeLatest(5 * DAY, 5 * DAY);
    const observed = new Set<string>();
    // Report days 5..90 (86 days), leaving days 0..4 to the boot span; drop 10
    // older days (days 81..90 absent) to simulate an offline stretch.
    for (let d = 5; d <= 80; d += 1) observed.add(dayKeyOffset(d));
    const pct = computeUptimePercent(latest, observed, 90, now, enrolledAt);
    expect(pct).toBeGreaterThan(85);
    expect(pct).toBeLessThan(95);
  });

  it('leaves an old continuously-up device at 100', () => {
    // Enrolled 200 days ago, booted 120 days ago, up continuously → boot span
    // covers the whole window → 100% with or without observed buckets.
    const enrolledAt = new Date(now.getTime() - 200 * DAY * 1000);
    const latest = makeLatest(120 * DAY, 120 * DAY);
    expect(computeUptimePercent(latest, NONE, 90, now, enrolledAt)).toBe(computeUptimePercent(latest, NONE, 90, now));
    expect(computeUptimePercent(latest, NONE, 90, now, enrolledAt)).toBe(100);
  });

  it('returns 100 when enrollment is at or after now (zero-length window)', () => {
    const latest = makeLatest(0, 0);
    expect(computeUptimePercent(latest, NONE, 90, now, now)).toBe(100);
    expect(computeUptimePercent(latest, NONE, 90, now, new Date(now.getTime() + DAY * 1000))).toBe(100);
  });
});

// Issue #1908: saturating curve helper — the foundation for all factor scorers.
describe('saturatingScore', () => {
  const { saturatingScore } = reliabilityScoringInternals;

  it('returns 100 for zero weighted count', () => expect(saturatingScore(0, 5)).toBe(100));
  it('returns 100 for negative weighted count', () => expect(saturatingScore(-1, 5)).toBe(100));
  it('returns 0 (not 100) for non-finite input — corrupted data must not read as perfect health', () => {
    expect(saturatingScore(NaN, 5)).toBe(0);
    expect(saturatingScore(Infinity, 5)).toBe(0);
  });
  it('at weightedCount = k the score is approximately 37 (exp(-1) ≈ 36.8)', () => {
    // exp(-k/k) = exp(-1) ≈ 0.368, so score ≈ 37 after rounding.
    expect(saturatingScore(5, 5)).toBe(37);
    expect(saturatingScore(3, 3)).toBe(37);
  });
  it('is strictly decreasing for counts 1 through 10 with k=5', () => {
    for (let n = 1; n <= 10; n++) {
      expect(saturatingScore(n, 5)).toBeLessThan(saturatingScore(n - 1, 5));
    }
  });
  it('never returns below 0 or above 100', () => {
    expect(saturatingScore(1000, 1)).toBeGreaterThanOrEqual(0);
    expect(saturatingScore(0.001, 5)).toBeLessThanOrEqual(100);
  });
});

// Issue #1908: scoreCrashes uses saturatingScore with K_CRASHES=3.
// weightedCount = crashCount30d + crashCount7d * 0.5
describe('scoreCrashes', () => {
  const { scoreCrashes } = reliabilityScoringInternals;

  it('returns 100 with no crashes', () => expect(scoreCrashes(0, 0)).toBe(100));
  // 1 crash (30d): weightedCount=1 → round(100*exp(-1/3)) = 72
  it('one 30d crash dents the score to ~72', () => expect(scoreCrashes(0, 1)).toBe(72));
  // 2 crashes (7d): weightedCount=2*0.5=1 → same curve → 72
  it('applies 0.5x weight to 7d crashes (2 seven-day crashes = 1 weighted)', () => expect(scoreCrashes(2, 0)).toBe(72));
  // reference: weightedCount=3 → exp(-3/3)=exp(-1) ≈ 37
  it('at weighted-count 3 the score is ~37 (exp(-1) reference point)', () => {
    // crashCount30d=3, crashCount7d=0: weightedCount=3
    expect(scoreCrashes(0, 3)).toBe(37);
  });
  // strict monotonicity across 30d crash counts 1..10 (no plateaus in meaningful range)
  it('is strictly monotonically decreasing for 1..10 crashes (no plateau)', () => {
    for (let n = 1; n <= 10; n++) {
      expect(scoreCrashes(0, n)).toBeLessThan(scoreCrashes(0, n - 1));
    }
  });
  // many crashes still produce a low but non-zero, finite value
  it('very many crashes approach but do not floor at 0 artificially (large count → low score)', () => {
    const score = scoreCrashes(10, 10); // weightedCount=10+5=15 → round(100*exp(-5)) ≈ 1
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThan(5);
  });
});

// Issue #1908: scoreHangs uses saturatingScore with K_HANGS=6.
// weightedCount = hangCount30d + unresolvedHangCount30d (unresolved double-counted)
describe('scoreHangs', () => {
  const { scoreHangs } = reliabilityScoringInternals;

  it('returns 100 with no hangs', () => expect(scoreHangs(0, 0)).toBe(100));
  // 1 resolved hang: weightedCount=1+0=1 → round(100*exp(-1/6)) ≈ 85
  it('one resolved hang → ~85', () => expect(scoreHangs(1, 0)).toBe(85));
  // 1 unresolved hang: weightedCount=1+1=2 → round(100*exp(-2/6)) ≈ 72
  it('one unresolved hang costs more than one resolved hang (2x weighted)', () => {
    const oneResolved = scoreHangs(1, 0);     // 85
    const oneUnresolved = scoreHangs(1, 1);   // 72
    expect(oneResolved).toBe(85);
    expect(oneUnresolved).toBe(72);
    expect(oneUnresolved).toBeLessThan(oneResolved);
  });
  // reference: weightedCount=6 (6 hangs, 0 unresolved) → exp(-1) ≈ 37
  it('at weighted-count 6 the score is ~37 (exp(-1) reference point)', () => {
    expect(scoreHangs(6, 0)).toBe(37);
  });
  // strict monotonicity: more hangs = lower score (no plateau in 1..12)
  it('is strictly monotonically decreasing for 1..12 hangs (no plateau)', () => {
    for (let n = 1; n <= 12; n++) {
      expect(scoreHangs(n, 0)).toBeLessThan(scoreHangs(n - 1, 0));
    }
  });
  it('approaches 0 with many hangs', () => expect(scoreHangs(20, 20)).toBe(0));
});

// Issue #1908: scoreServiceFailures uses saturatingScore with K_SERVICES=5.
// weightedCount = max(0, failures - recovered * 0.5)
describe('scoreServiceFailures', () => {
  const { scoreServiceFailures } = reliabilityScoringInternals;

  it('returns 100 with no failures', () => expect(scoreServiceFailures(0, 0)).toBe(100));
  // 1 failure, 1 recovered: weightedCount=max(0, 1-0.5)=0.5 → round(100*exp(-0.5/5)) ≈ 90
  it('recovered failures get half-weight credit', () => expect(scoreServiceFailures(1, 1)).toBe(90));
  // many recoveries with no failures: weightedCount=max(0, 0-5)=0 → still 100
  it('recoveries alone cannot push score above 100', () => expect(scoreServiceFailures(0, 10)).toBe(100));
  // reference: 5 failures 0 recovered → weightedCount=5 → exp(-1) ≈ 37
  it('at 5 failures (0 recovered) the score is ~37 (exp(-1) reference point)', () => {
    expect(scoreServiceFailures(5, 0)).toBe(37);
  });
  // The headline regression (#1908): 1 vs 3 vs 5 failures yield DISTINCT descending scores
  it('discrimination: 1, 3, and 5 failures produce three distinct descending scores', () => {
    const s1 = scoreServiceFailures(1, 0); // 82
    const s3 = scoreServiceFailures(3, 0); // 55
    const s5 = scoreServiceFailures(5, 0); // 37
    expect(s1).toBe(82);
    expect(s3).toBe(55);
    expect(s5).toBe(37);
    expect(s1).toBeGreaterThan(s3);
    expect(s3).toBeGreaterThan(s5);
  });
  // strict monotonicity: more failures = lower score (no plateau in 1..10)
  it('is strictly monotonically decreasing for 1..10 failures (no plateau)', () => {
    for (let n = 1; n <= 10; n++) {
      expect(scoreServiceFailures(n, 0)).toBeLessThan(scoreServiceFailures(n - 1, 0));
    }
  });
  it('10 failures (0 recovered) → low score (~14), not floored to 0', () => {
    expect(scoreServiceFailures(10, 0)).toBe(14);
  });
  // Breeze's own service failures (agent auto-update restarts) are a subset of
  // the 30d count and are excluded from the score entirely.
  it('self service failures are excluded from the weighted count', () => {
    // All 5 failures are ours → clean score.
    expect(scoreServiceFailures(5, 0, 30, 5)).toBe(100);
    // 6 total with 1 ours scores the same as 5 genuine failures.
    expect(scoreServiceFailures(6, 0, 30, 1)).toBe(scoreServiceFailures(5, 0, 30));
    // Omitting the argument keeps legacy behavior (nothing excluded).
    expect(scoreServiceFailures(5, 0, 30)).toBe(37);
  });
});

// Issue #1908: scoreHardwareErrors uses saturatingScore with K_HARDWARE=3.
// weightedCount = critical*2 + error*1 + warning*0.34
describe('scoreHardwareErrors', () => {
  const { scoreHardwareErrors } = reliabilityScoringInternals;

  it('returns 100 with no errors', () => expect(scoreHardwareErrors(0, 0, 0)).toBe(100));
  // 1 critical: weightedCount=2 → round(100*exp(-2/3)) ≈ 51
  it('one critical error (w=2) → ~51', () => expect(scoreHardwareErrors(1, 0, 0)).toBe(51));
  // 1 error: weightedCount=1 → round(100*exp(-1/3)) ≈ 72
  it('one error-severity event (w=1) → ~72', () => expect(scoreHardwareErrors(0, 1, 0)).toBe(72));
  // 1 warning: weightedCount=0.34 → round(100*exp(-0.34/3)) ≈ 89
  it('one warning (w=0.34) → ~89', () => expect(scoreHardwareErrors(0, 0, 1)).toBe(89));
  // reference: 2 criticals → weightedCount=4 → round(100*exp(-4/3)) ≈ 26
  it('two critical errors → ~26 (severity-weighting reference point)', () => expect(scoreHardwareErrors(2, 0, 0)).toBe(26));
  // strict severity ordering
  it('critical costs more than error which costs more than warning (strict ordering)', () => {
    expect(scoreHardwareErrors(1, 0, 0)).toBeLessThan(scoreHardwareErrors(0, 1, 0));
    expect(scoreHardwareErrors(0, 1, 0)).toBeLessThan(scoreHardwareErrors(0, 0, 1));
  });
  // strict monotonicity: more criticals = lower score in 1..6
  it('is strictly monotonically decreasing for 1..6 critical errors (no plateau)', () => {
    for (let n = 1; n <= 6; n++) {
      expect(scoreHardwareErrors(n, 0, 0)).toBeLessThan(scoreHardwareErrors(n - 1, 0, 0));
    }
  });
  // 4 criticals: weightedCount=8 → round(100*exp(-8/3)) ≈ 7 (no longer clamps to 0 artificially)
  it('4 critical errors → low score (~7), not hard-floored at 0', () => {
    expect(scoreHardwareErrors(4, 0, 0)).toBe(7);
  });
});

// Issue #1908 (a/b): rate-normalization by observed up-days.
describe('fault scorers — rate-normalization (#1908)', () => {
  const { scoreCrashes, scoreHangs, scoreServiceFailures, scoreHardwareErrors } =
    reliabilityScoringInternals;

  it('mature 30-up-day device is a no-op (matches the raw-count curve)', () => {
    // Default arg is 30, so the existing scoreCrashes(0,1)===72 already proves
    // this; here we assert it explicitly with the arg passed.
    expect(scoreCrashes(0, 1, 30)).toBe(72);
    expect(scoreHangs(1, 0, 30)).toBe(85);
    expect(scoreServiceFailures(5, 0, 30)).toBe(37);
    expect(scoreHardwareErrors(1, 0, 0, 30)).toBe(51);
  });

  it('same count + fewer observed up-days → strictly lower score', () => {
    expect(scoreCrashes(0, 2, 15)).toBeLessThan(scoreCrashes(0, 2, 30));
    expect(scoreHangs(2, 0, 15)).toBeLessThan(scoreHangs(2, 0, 30));
    expect(scoreServiceFailures(3, 0, 15)).toBeLessThan(scoreServiceFailures(3, 0, 30));
    expect(scoreHardwareErrors(0, 2, 0, 15)).toBeLessThan(scoreHardwareErrors(0, 2, 0, 30));
  });

  it('MIN_DAYS floor: sparse device uses denominator 14, not its real up-days', () => {
    // 3 up-days and 7 up-days both floor to 14 → identical score.
    expect(scoreCrashes(0, 1, 3)).toBe(scoreCrashes(0, 1, 7));
    expect(scoreCrashes(0, 1, 7)).toBe(scoreCrashes(0, 1, 14));
  });

  it('zero observed up-days floors to MIN_DAYS (not a divide-by-zero / 0-score)', () => {
    // observedUpDays30 = 0 is reachable; max(0, 14) = 14 → same as the 14 curve.
    expect(scoreCrashes(0, 1, 0)).toBe(49);
  });

  it('REFERENCE_DAYS cap: >30 up-days (inclusive-window edge) still an exact no-op', () => {
    // The 30d count window spans 31 inclusive day-keys, so observedUpDays30 can
    // reach 31; the denominator is capped at 30 so it stays the bit-identical no-op.
    expect(scoreCrashes(0, 1, 31)).toBe(scoreCrashes(0, 1, 30)); // both 72
    expect(scoreCrashes(0, 1, 31)).toBe(72);
  });

  it('service-failure recovered-floor holds under rate-normalization', () => {
    // recovered ≥ failures → weightedCount 0 → rate 0 → 100, even at low up-days
    // (the Math.max(0,…) must floor BEFORE the divide, never a negative rate).
    expect(scoreServiceFailures(0, 10, 14)).toBe(100);
    expect(scoreServiceFailures(1, 10, 14)).toBe(100);
  });

  it('young-device reference table for one 30d crash (k_rate=0.1, MIN_DAYS=14)', () => {
    expect(scoreCrashes(0, 1, 30)).toBe(72); // mature
    expect(scoreCrashes(0, 1, 14)).toBe(49);
    expect(scoreCrashes(0, 1, 7)).toBe(49);  // floored to 14
    expect(scoreCrashes(0, 1, 3)).toBe(49);  // floored to 14
  });

  it('monotonic in up-days: more observation → higher score at fixed count', () => {
    const a = scoreCrashes(0, 3, 14);
    const b = scoreCrashes(0, 3, 22);
    const c = scoreCrashes(0, 3, 30);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });
});

// NOTE: the end-to-end wiring — countObservedUpDaysInWindow feeding the four
// scorer call sites inside computeAndPersistDeviceReliability — is covered by a
// real-DB test in reliabilityWeightProfile.integration.test.ts ("rate-normalizes
// faults by observed up-days"). A unit test here can only re-implement the
// composition it claims to guard, so it would not catch a dropped call-site arg.

// Issue #1908: scoreDailyBucket uses the same saturatingScore exponential form
// as the headline scorers (so a day with more faults always scores lower), but
// on the RAW K_* constants — it is intentionally NOT rate-normalized by up-days
// (a per-day bucket is already a one-day quantity).
describe('scoreDailyBucket', () => {
  const { scoreDailyBucket } = reliabilityScoringInternals;

  function emptyBucket(overrides: Record<string, number> = {}) {
    return makeBucket({
      crashCount: 0,
      hangCount: 0,
      unresolvedHangCount: 0,
      serviceFailureCount: 0,
      recoveredServiceCount: 0,
      hardwareCriticalCount: 0,
      hardwareErrorSeverityCount: 0,
      hardwareWarningCount: 0,
      ...overrides,
    });
  }

  it('returns 100 for a perfectly clean bucket', () => {
    expect(scoreDailyBucket(emptyBucket())).toBe(100);
  });

  it('a bucket with 1 crash scores lower than a clean bucket', () => {
    expect(scoreDailyBucket(emptyBucket({ crashCount: 1 }))).toBeLessThan(100);
  });

  it('a bucket with more crashes scores strictly lower than one with fewer', () => {
    const s1 = scoreDailyBucket(emptyBucket({ crashCount: 1 }));
    const s2 = scoreDailyBucket(emptyBucket({ crashCount: 2 }));
    const s4 = scoreDailyBucket(emptyBucket({ crashCount: 4 }));
    expect(s1).toBeGreaterThan(s2);
    expect(s2).toBeGreaterThan(s4);
  });

  it('a bucket with 1 service failure scores lower than a clean bucket', () => {
    expect(scoreDailyBucket(emptyBucket({ serviceFailureCount: 1 }))).toBeLessThan(100);
  });

  it('a bucket whose service failures are all Breeze self-failures scores clean', () => {
    expect(scoreDailyBucket(emptyBucket({ serviceFailureCount: 2, selfServiceFailureCount: 2 }))).toBe(100);
  });

  it('a bucket with more service failures scores strictly lower (no plateau)', () => {
    for (let n = 1; n <= 8; n++) {
      const prev = scoreDailyBucket(emptyBucket({ serviceFailureCount: n - 1 }));
      const curr = scoreDailyBucket(emptyBucket({ serviceFailureCount: n }));
      expect(curr).toBeLessThan(prev);
    }
  });

  it('a bucket with 1 critical hardware error scores lower than a clean bucket', () => {
    expect(scoreDailyBucket(emptyBucket({ hardwareCriticalCount: 1 }))).toBeLessThan(100);
  });

  it('a bucket with mixed faults scores lower than a single-fault bucket', () => {
    const oneCrash = scoreDailyBucket(emptyBucket({ crashCount: 1 }));
    const mixed = scoreDailyBucket(emptyBucket({ crashCount: 1, serviceFailureCount: 2, hardwareCriticalCount: 1 }));
    expect(mixed).toBeLessThan(oneCrash);
  });

  it('downweights app crashes vs. real device crashes (app_crash weighting)', () => {
    // 4 per-app crashes dent the score far less than 4 BSODs. At weight 0.25 the
    // effective load of 4 app crashes is 4×0.25 = 1.0, ≈ a single real crash.
    const fourApp = scoreDailyBucket(emptyBucket({ crashCount: 4, appCrashCount: 4 }));
    const fourReal = scoreDailyBucket(emptyBucket({ crashCount: 4, appCrashCount: 0 }));
    const oneReal = scoreDailyBucket(emptyBucket({ crashCount: 1, appCrashCount: 0 }));
    expect(fourApp).toBeGreaterThan(fourReal);
    expect(fourApp).toBeCloseTo(oneReal);
  });
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

  // #1738: a newly-enrolled device that has been up its whole (short) life now
  // computes uptime30d === 100 thanks to the enrollment clamp, so it must NOT
  // be flagged with an `uptime` top-issue purely for time before it existed.
  it('does not flag an uptime issue when uptime30d is 100 (young all-up device)', () => {
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
    expect(issues.find((i) => i.type === 'uptime')).toBeUndefined();
  });

  it('flags an uptime issue (warning) when uptime30d is between 90 and 95', () => {
    const issues = computeTopIssues({
      dailyBuckets: [],
      now,
      uptime30d: 92,
      crashCount30d: 0,
      hangCount30d: 0,
      serviceFailureCount30d: 0,
      hardwareErrorCount30d: 0,
      criticalHardwareCount30d: 0,
    });
    const uptime = issues.find((i) => i.type === 'uptime');
    expect(uptime?.severity).toBe('warning');
  });

  it('flags an uptime issue (critical) when uptime30d is below 90', () => {
    const issues = computeTopIssues({
      dailyBuckets: [],
      now,
      uptime30d: 80,
      crashCount30d: 0,
      hangCount30d: 0,
      serviceFailureCount30d: 0,
      hardwareErrorCount30d: 0,
      criticalHardwareCount30d: 0,
    });
    const uptime = issues.find((i) => i.type === 'uptime');
    expect(uptime?.severity).toBe('critical');
  });

  // Issue #1721: workstation/laptop roles should not be flagged with an uptime
  // top-issue, since regular sleep/shutdown is expected for those devices.
  it('suppresses the uptime issue when suppressUptimeIssue is true (low uptime)', () => {
    const issues = computeTopIssues({
      dailyBuckets: [],
      now,
      uptime30d: 80,
      crashCount30d: 0,
      hangCount30d: 0,
      serviceFailureCount30d: 0,
      hardwareErrorCount30d: 0,
      criticalHardwareCount30d: 0,
      suppressUptimeIssue: true,
    });
    expect(issues.find((i) => i.type === 'uptime')).toBeUndefined();
  });

  it('still flags non-uptime issues when suppressUptimeIssue is true', () => {
    const issues = computeTopIssues({
      dailyBuckets: [],
      now,
      uptime30d: 80,
      crashCount30d: 3,
      hangCount30d: 0,
      serviceFailureCount30d: 0,
      hardwareErrorCount30d: 0,
      criticalHardwareCount30d: 0,
      suppressUptimeIssue: true,
    });
    expect(issues.find((i) => i.type === 'uptime')).toBeUndefined();
    expect(issues.find((i) => i.type === 'crashes')?.severity).toBe('critical');
  });

  it('still flags the uptime issue when suppressUptimeIssue is false (default behaviour preserved)', () => {
    const issues = computeTopIssues({
      dailyBuckets: [],
      now,
      uptime30d: 80,
      crashCount30d: 0,
      hangCount30d: 0,
      serviceFailureCount30d: 0,
      hardwareErrorCount30d: 0,
      criticalHardwareCount30d: 0,
      suppressUptimeIssue: false,
    });
    expect(issues.find((i) => i.type === 'uptime')?.severity).toBe('critical');
  });
});

// Issue #1721: device-type-aware reliability weight profiles.
describe('device-role weight profiles', () => {
  const {
    resolveWeightProfile,
    isWorkstationRole,
    INFRA_FACTOR_WEIGHTS,
    WORKSTATION_FACTOR_WEIGHTS,
  } = reliabilityScoringInternals;

  const sum = (w: typeof INFRA_FACTOR_WEIGHTS) =>
    w.uptime + w.crashes + w.hangs + w.serviceFailures + w.hardwareErrors;

  it('both profiles sum to 100', () => {
    expect(sum(INFRA_FACTOR_WEIGHTS)).toBe(100);
    expect(sum(WORKSTATION_FACTOR_WEIGHTS)).toBe(100);
  });

  it('the infra profile keeps the historical uptime weight of 30', () => {
    expect(INFRA_FACTOR_WEIGHTS.uptime).toBe(30);
  });

  it('the workstation profile drops uptime to zero', () => {
    expect(WORKSTATION_FACTOR_WEIGHTS.uptime).toBe(0);
  });

  it('classifies only the workstation role as workstation-class', () => {
    expect(isWorkstationRole('workstation')).toBe(true);
    expect(isWorkstationRole('server')).toBe(false);
    expect(isWorkstationRole('nas')).toBe(false);
    expect(isWorkstationRole('unknown')).toBe(false);
    expect(isWorkstationRole(null)).toBe(false);
    expect(isWorkstationRole(undefined)).toBe(false);
  });

  it('resolves the workstation profile (name + weights) for workstation devices', () => {
    const profile = resolveWeightProfile('workstation');
    expect(profile.name).toBe('workstation');
    expect(profile.weights).toBe(WORKSTATION_FACTOR_WEIGHTS);
  });

  it.each(['server', 'nas', 'router', 'switch', 'firewall', 'printer', 'unknown', null, undefined])(
    'resolves the infra profile (name + weights) for role %s',
    (role) => {
      const profile = resolveWeightProfile(role as string | null | undefined);
      expect(profile.name).toBe('infra');
      expect(profile.weights).toBe(INFRA_FACTOR_WEIGHTS);
    }
  );

  // A normally-rebooting laptop (low uptime, otherwise clean) should score far
  // higher under the workstation profile than under the infra profile, because
  // uptime no longer drags the weighted total down.
  it('a low-uptime but otherwise-clean device scores higher under the workstation profile', () => {
    const uptimeScore = 0; // <=90% uptime -> 0 on the uptime factor
    const cleanScore = 100; // no crashes/hangs/service/hardware faults
    const weighted = (w: typeof INFRA_FACTOR_WEIGHTS) =>
      (uptimeScore * w.uptime
        + cleanScore * w.crashes
        + cleanScore * w.hangs
        + cleanScore * w.serviceFailures
        + cleanScore * w.hardwareErrors) / 100;

    const infra = weighted(INFRA_FACTOR_WEIGHTS);
    const workstation = weighted(WORKSTATION_FACTOR_WEIGHTS);

    expect(infra).toBe(70); // 30% uptime weight lost entirely
    expect(workstation).toBe(100); // uptime carries no weight
    expect(workstation).toBeGreaterThan(infra);
  });
});

describe('reliability explanation drivers', () => {
  it('orders drivers by weighted lost points and keeps numeric evidence only', () => {
    const drivers = reliabilityScoringInternals.buildReliabilityDrivers({
      factors: {
        uptime: { score: 90, weight: 30, uptime30d: 99.2, ignored: 'not-number' },
        crashes: { score: 20, weight: 25, crashCount30d: 4 },
        hangs: { score: 100, weight: 15, hangCount30d: 0 },
      },
    });

    expect(drivers.map((driver) => driver.factor)).toEqual(['crashes', 'uptime', 'hangs']);
    expect(drivers[0]).toEqual(expect.objectContaining({
      factor: 'crashes',
      label: 'Crashes',
      lostPoints: 20,
      evidence: { crashCount30d: 4 },
    }));
    expect(drivers[1]?.evidence).toEqual({ uptime30d: 99.2 });
  });
});

describe('computeReliabilityEvaluationSummary', () => {
  const devices = [
    {
      deviceId: 'device-a',
      orgId: 'org-1',
      siteId: 'site-1',
      hostname: 'alpha',
      reliabilityScore: 45,
      computedAt: new Date('2026-06-18T12:00:00.000Z'),
    },
    {
      deviceId: 'device-b',
      orgId: 'org-1',
      siteId: 'site-1',
      hostname: 'beta',
      reliabilityScore: 62,
      computedAt: new Date('2026-06-18T12:00:00.000Z'),
    },
    {
      deviceId: 'device-c',
      orgId: 'org-1',
      siteId: 'site-2',
      hostname: 'gamma',
      reliabilityScore: 91,
      computedAt: new Date('2026-06-18T12:00:00.000Z'),
    },
  ];

  it('computes precision from labeled at-risk devices and reports missed failures', () => {
    const summary = reliabilityScoringInternals.computeReliabilityEvaluationSummary(devices, [
      { deviceId: 'device-a', outcome: 'failure_confirmed', occurredAt: new Date('2026-06-18T13:00:00.000Z') },
      { deviceId: 'device-b', outcome: 'false_alarm', occurredAt: new Date('2026-06-18T13:00:00.000Z') },
      { deviceId: 'device-c', outcome: 'replaced', occurredAt: new Date('2026-06-18T13:00:00.000Z') },
    ], { atRiskMaxScore: 70, labelWindowDays: 90 });

    expect(summary).toEqual(expect.objectContaining({
      evaluatedDevices: 3,
      atRiskDevices: 2,
      labeledAtRiskDevices: 2,
      truePositiveDevices: 1,
      falsePositiveDevices: 1,
      missedFailureDevices: 1,
      unlabeledAtRiskDevices: 0,
      confirmedFailureLabels: 1,
      replacementLabels: 1,
      falseAlarmLabels: 1,
      precision: 0.5,
    }));
  });

  it('uses the latest label per device for prediction outcome scoring', () => {
    const summary = reliabilityScoringInternals.computeReliabilityEvaluationSummary(devices, [
      { deviceId: 'device-a', outcome: 'false_alarm', occurredAt: new Date('2026-06-18T12:00:00.000Z') },
      { deviceId: 'device-a', outcome: 'failure_confirmed', occurredAt: new Date('2026-06-18T13:00:00.000Z') },
    ], { atRiskMaxScore: 70, labelWindowDays: 90 });

    expect(summary.truePositiveDevices).toBe(1);
    expect(summary.falsePositiveDevices).toBe(0);
    expect(summary.unlabeledAtRiskDevices).toBe(1);
    expect(summary.precision).toBe(1);
  });
});

describe('aggregateReliabilityOffenders', () => {
  const { aggregateReliabilityOffenders } = reliabilityScoringInternals;

  it('groups distinct events by offender and ranks by count', () => {
    const rows = [
      makeHistoryRow({
        serviceFailures: [
          { serviceName: 'Spooler', timestamp: '2026-02-20T10:01:00.000Z', recovered: true },
          { serviceName: 'Spooler', timestamp: '2026-02-20T11:01:00.000Z', recovered: false },
          { serviceName: 'WinDefend', timestamp: '2026-02-20T12:01:00.000Z', recovered: false },
        ],
        hardwareErrors: [
          { type: 'disk', severity: 'warning', source: 'disk0', timestamp: '2026-02-20T10:05:00.000Z' },
          { type: 'disk', severity: 'critical', source: 'disk0', timestamp: '2026-02-20T13:05:00.000Z' },
        ],
        appHangs: [
          { processName: 'chrome.exe', timestamp: '2026-02-20T10:09:00.000Z', duration: 5, resolved: false },
        ],
      }),
    ];

    const result = aggregateReliabilityOffenders(rows);

    expect(result.services).toEqual([
      { key: 'Spooler', label: 'Spooler', count: 2, lastOccurrence: '2026-02-20T11:01:00.000Z', detail: '1/2 recovered' },
      { key: 'WinDefend', label: 'WinDefend', count: 1, lastOccurrence: '2026-02-20T12:01:00.000Z' },
    ]);
    // Worst severity wins for the detail; the latest timestamp is retained.
    expect(result.hardware).toEqual([
      { key: 'disk0', label: 'disk0', count: 2, lastOccurrence: '2026-02-20T13:05:00.000Z', detail: 'critical' },
    ]);
    expect(result.hangs).toEqual([
      { key: 'chrome.exe', label: 'chrome.exe', count: 1, lastOccurrence: '2026-02-20T10:09:00.000Z', detail: '1 unresolved' },
    ]);
  });

  it('de-duplicates the same event re-reported across overlapping rows (issue #1905 parity)', () => {
    const dup = { serviceName: 'Spooler', timestamp: '2026-02-20T10:01:00.000Z', errorCode: '7', recovered: false };
    const rows = [
      makeHistoryRow({ serviceFailures: [dup] }),
      makeHistoryRow({ collectedAt: new Date('2026-02-20T12:00:00.000Z'), serviceFailures: [dup, { ...dup }] }),
    ];

    const result = aggregateReliabilityOffenders(rows);

    expect(result.services).toEqual([
      { key: 'Spooler', label: 'Spooler', count: 1, lastOccurrence: '2026-02-20T10:01:00.000Z' },
    ]);
  });

  it('honors the top-N limit and labels nameless offenders with a placeholder', () => {
    const rows = [
      makeHistoryRow({
        serviceFailures: [
          { serviceName: 'A', timestamp: '2026-02-20T10:01:00.000Z', recovered: false },
          { serviceName: 'B', timestamp: '2026-02-20T10:02:00.000Z', recovered: false },
          { serviceName: '', timestamp: '2026-02-20T10:03:00.000Z', recovered: false },
        ],
      }),
    ];

    const result = aggregateReliabilityOffenders(rows, 2);

    expect(result.services).toHaveLength(2);
    expect(result.services.map((offender) => offender.label)).not.toContain('');
  });

  it('keeps the worst hardware severity even when a lower one is reported later', () => {
    const rows = [
      makeHistoryRow({
        hardwareErrors: [
          { type: 'disk', severity: 'critical', source: 'disk0', timestamp: '2026-02-20T10:00:00.000Z' },
          { type: 'disk', severity: 'warning', source: 'disk0', timestamp: '2026-02-20T11:00:00.000Z' },
          { type: 'disk', severity: 'bogus' as never, source: 'disk0', timestamp: '2026-02-20T12:00:00.000Z' },
        ],
      }),
    ];

    const result = aggregateReliabilityOffenders(rows);

    // critical reported first must not be downgraded by a later warning / unknown severity.
    expect(result.hardware[0]).toMatchObject({ key: 'disk0', count: 3, detail: 'critical' });
  });

  it('excludes non-genuine hardware (old-agent SCM/DCOM/IOKit junk) from the drill-down', () => {
    const rows = [
      makeHistoryRow({
        hardwareErrors: [
          { type: 'unknown', severity: 'error', source: 'service control manager', eventId: '7000', timestamp: '2026-02-20T10:00:00.000Z' },
          { type: 'unknown', severity: 'error', source: 'com.apple.iokit.cfplugin', eventId: 'x', timestamp: '2026-02-20T10:01:00.000Z' },
          { type: 'disk', severity: 'critical', source: 'nvme', eventId: '7', timestamp: '2026-02-20T10:02:00.000Z' },
        ],
      }),
    ];

    const result = aggregateReliabilityOffenders(rows);

    // The two junk sources must not appear; only the genuine nvme fault does.
    expect(result.hardware).toEqual([
      { key: 'nvme', label: 'nvme', count: 1, lastOccurrence: '2026-02-20T10:02:00.000Z', detail: 'critical' },
    ]);
  });

  it('breaks count ties by most-recent occurrence', () => {
    const rows = [
      makeHistoryRow({
        serviceFailures: [
          { serviceName: 'Older', timestamp: '2026-02-20T08:00:00.000Z', recovered: false },
          { serviceName: 'Newer', timestamp: '2026-02-20T20:00:00.000Z', recovered: false },
        ],
      }),
    ];

    const result = aggregateReliabilityOffenders(rows, 1);

    // Equal counts (1 each) → the more recent offender ranks first and survives the top-1 slice.
    expect(result.services).toEqual([
      { key: 'Newer', label: 'Newer', count: 1, lastOccurrence: '2026-02-20T20:00:00.000Z' },
    ]);
  });

  it('excludes events whose day falls outside the supplied window', () => {
    const rows = [
      makeHistoryRow({
        collectedAt: new Date('2026-02-20T10:00:00.000Z'),
        serviceFailures: [
          { serviceName: 'InWindow', timestamp: '2026-02-19T10:00:00.000Z', recovered: false },
          // Re-reported in a recent row but its own day is well before the window start.
          { serviceName: 'OldReReport', timestamp: '2026-01-01T10:00:00.000Z', recovered: false },
        ],
      }),
    ];
    const window = { sinceKey: '2026-02-13', todayKey: '2026-02-20' };

    const filtered = aggregateReliabilityOffenders(rows, 5, window);
    expect(filtered.services.map((offender) => offender.label)).toEqual(['InWindow']);

    // Without a window the old re-report is still counted (pure aggregation).
    const unfiltered = aggregateReliabilityOffenders(rows);
    expect(unfiltered.services.map((offender) => offender.label).sort()).toEqual(['InWindow', 'OldReReport']);
  });
});
