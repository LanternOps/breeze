import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {},
}));

import { reliabilityScoringInternals as I, scoreDeviceReliability } from './reliabilityScoring';

const DAY = 86_400_000;
const windowEnd = new Date('2026-03-31T12:00:00.000Z');
const at = (daysAgo: number, hour = 10) => new Date(windowEnd.getTime() - daysAgo * DAY - (12 - hour) * 3_600_000);

/** One sample per day for `days` days ending at windowEnd; boot = 1h before each sample. */
function dailyRows(days: number, extra: (daysAgo: number) => Record<string, unknown> = () => ({})) {
  return Array.from({ length: days }, (_, i) => {
    const daysAgo = days - 1 - i;
    const collectedAt = at(daysAgo);
    return {
      collectedAt, uptimeSeconds: 3600, bootTime: new Date(collectedAt.getTime() - 3_600_000),
      crashEvents: [], appHangs: [], serviceFailures: [], hardwareErrors: [], ...extra(daysAgo),
    };
  });
}
const crashAt = (daysAgo: number) => ({ crashEvents: [{ type: 'bsod', timestamp: at(daysAgo, 9).toISOString() }] });
const baseInput = { latest: null, deviceRole: 'workstation', enrolledAt: new Date('2025-01-01T00:00:00.000Z'), windowEnd };
const marker = (daysAgo: number) => ({ id: 'b-1', baselineAt: at(daysAgo, 0), reason: 'remediated' as const, source: 'manual' as const });

describe('scoreDeviceReliability (#5876)', () => {
  it('without a marker scores a crash exactly as the factor scorer does', () => {
    const rows = dailyRows(30, (d) => (d === 3 ? crashAt(3) : {}));
    const { values } = scoreDeviceReliability({ ...baseInput, rows: rows as any, baseline: null });
    expect(values.crashCount30d).toBe(1);
    expect(values.crashScore).toBe(I.scoreCrashes(I.effectiveCrashLoad(1, 0), I.effectiveCrashLoad(1, 0), 30));
    expect(values.computedAt).toEqual(windowEnd);
    expect((values.details as any).baseline).toBeUndefined();
  });

  it('ignores a crash before the marker and reports provisional, stable trend, no MTBF', () => {
    const rows = dailyRows(30, (d) => (d === 10 ? crashAt(10) : {}));
    const { values } = scoreDeviceReliability({ ...baseInput, rows: rows as any, baseline: marker(5) });
    expect(values.crashCount30d).toBe(0);
    expect(values.crashScore).toBe(100);
    expect(values.trendDirection).toBe('stable');
    expect(values.trendConfidence).toBe(0);
    expect(values.mtbfHours).toBeNull();
    expect((values.details as any).baseline).toMatchObject({ id: 'b-1', provisional: true, reportedDaysSinceBaseline: 6 });
  });

  it('counts a post-marker crash against the 14-day rate floor, not the full 30 days', () => {
    const rows = dailyRows(30, (d) => (d === 2 ? crashAt(2) : {}));
    const { values } = scoreDeviceReliability({ ...baseInput, rows: rows as any, baseline: marker(5) });
    expect(values.crashCount30d).toBe(1);
    expect(values.crashScore).toBe(I.scoreCrashes(1, 1, 6)); // floor lifts denom 6 → 14 inside the scorer
    expect(values.crashScore).toBeLessThan(I.scoreCrashes(1, 1, 30));
  });

  it('matures after 14 reported days since the marker', () => {
    const rows = dailyRows(30);
    const { values } = scoreDeviceReliability({ ...baseInput, rows: rows as any, baseline: marker(20) });
    expect((values.details as any).baseline).toMatchObject({ provisional: false, reportedDaysSinceBaseline: 21 });
  });

  it('does not mature a device that went silent after the fix, even inside a long boot span', () => {
    // Two samples right after the marker; the second claims a boot 25 days ago that spans "now".
    const rows = [
      { collectedAt: at(19), uptimeSeconds: 3600, bootTime: at(25), crashEvents: [], appHangs: [], serviceFailures: [], hardwareErrors: [] },
      { collectedAt: at(18), uptimeSeconds: 7200, bootTime: at(25), crashEvents: [], appHangs: [], serviceFailures: [], hardwareErrors: [] },
    ];
    const latest = { collectedAt: at(18), uptimeSeconds: 7200, bootTime: at(25) };
    const { values } = scoreDeviceReliability({ ...baseInput, latest, rows: rows as any, baseline: marker(20) });
    expect((values.details as any).baseline).toMatchObject({ provisional: true, reportedDaysSinceBaseline: 2 });
  });

  it('bounds coverageDays by the rows actually available', () => {
    const { coverageDays } = scoreDeviceReliability({ ...baseInput, rows: dailyRows(10) as any, baseline: null });
    expect(coverageDays).toBe(10);
    expect(scoreDeviceReliability({ ...baseInput, rows: [], baseline: null }).coverageDays).toBe(0);
  });
});

describe('buildHistoryPoints (#5876)', () => {
  it('dedupes a re-posted crash and flags pre-marker days instead of dropping them', () => {
    const crash = { type: 'bsod', timestamp: '2026-03-20T09:00:00.000Z' };
    const rows = [
      { collectedAt: new Date('2026-03-20T10:00:00.000Z'), uptimeSeconds: 60, bootTime: new Date('2026-03-20T09:30:00.000Z'), crashEvents: [crash], appHangs: [], serviceFailures: [], hardwareErrors: [] },
      { collectedAt: new Date('2026-03-20T11:00:00.000Z'), uptimeSeconds: 120, bootTime: new Date('2026-03-20T09:30:00.000Z'), crashEvents: [crash], appHangs: [], serviceFailures: [], hardwareErrors: [] },
      { collectedAt: new Date('2026-03-25T11:00:00.000Z'), uptimeSeconds: 120, bootTime: new Date('2026-03-25T09:30:00.000Z'), crashEvents: [], appHangs: [], serviceFailures: [], hardwareErrors: [] },
    ];
    const points = I.buildHistoryPoints(rows as any, new Date('2026-03-22T00:00:00.000Z'), windowEnd, 30);
    const day20 = points.find((p) => p.date === '2026-03-20')!;
    expect(day20.crashCount).toBe(1);
    expect(day20.beforeBaseline).toBe(true);
    expect(points.find((p) => p.date === '2026-03-25')!.beforeBaseline).toBe(false);
    expect(day20.reliabilityEstimate).toBe(I.scoreDailyBucket(I.sortDailyBuckets((() => {
      const m = new Map(); I.mergeRowsIntoDailyBuckets(m, rows.slice(0, 2) as any); return m; })())[0]!));
  });
});
