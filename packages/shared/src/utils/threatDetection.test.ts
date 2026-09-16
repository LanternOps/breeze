import { describe, it, expect } from 'vitest';
import { resolutionStats, countBy, coverageGapLine, SEVERITY_ORDER } from './threatDetection';

function hoursRow([from, to]: number[]) {
  return {
    reportedAt: new Date((from ?? 0) * 3600_000).toISOString(),
    resolvedAt: new Date((to ?? 0) * 3600_000).toISOString(),
  };
}

describe('resolutionStats', () => {
  it('returns nulls for an empty set — unmeasured, not zero', () => {
    expect(resolutionStats([])).toEqual({ meanResolveHours: null, medianResolveHours: null });
  });

  it('returns nulls when nothing in the set was resolved', () => {
    expect(resolutionStats([
      { reportedAt: '2026-09-01T00:00:00Z', resolvedAt: null },
    ] as never)).toEqual({ meanResolveHours: null, medianResolveHours: null });
  });

  it('ignores unresolved incidents rather than counting them as instant', () => {
    const stats = resolutionStats([
      { reportedAt: '2026-09-01T00:00:00Z', resolvedAt: '2026-09-01T02:00:00Z' },
      { reportedAt: '2026-09-02T00:00:00Z', resolvedAt: null },
    ] as never);
    expect(stats.meanResolveHours).toBe(2);
  });

  it('takes the middle value for an odd count and the mean of the middle two for even', () => {
    const odd = resolutionStats([[0, 1], [0, 3], [0, 11]].map(hoursRow) as never);
    expect(odd.medianResolveHours).toBe(3);
    const even = resolutionStats([[0, 1], [0, 3], [0, 5], [0, 11]].map(hoursRow) as never);
    expect(even.medianResolveHours).toBe(4);
  });

  it('never returns a negative duration for a clock-skewed row', () => {
    const stats = resolutionStats([
      { reportedAt: '2026-09-01T05:00:00Z', resolvedAt: '2026-09-01T04:00:00Z' },
    ] as never);
    expect(stats.meanResolveHours).toBe(0);
  });
});

describe('countBy', () => {
  it('counts by the named key and buckets a missing value as unknown', () => {
    expect(countBy([
      { severity: 'high' }, { severity: 'high' }, { severity: null },
    ] as never, 'severity')).toEqual({ high: 2, unknown: 1 });
  });

  it('orders severity buckets by SEVERITY_ORDER, not alphabetically', () => {
    const counts = countBy([
      { severity: 'low' }, { severity: 'critical' }, { severity: 'medium' },
    ] as never, 'severity');
    expect(Object.keys(counts)).toEqual(['critical', 'medium', 'low']);
    expect(SEVERITY_ORDER[0]).toBe('critical');
  });
});

describe('coverageGapLine', () => {
  it('is empty when the covered window equals the period and nothing was withheld', () => {
    expect(coverageGapLine({
      periodStart: '2026-09-01', periodEnd: '2026-09-30',
      coveredFrom: '2026-09-01', coveredTo: '2026-09-30', sourceStatus: 'ok',
    })).toBe('');
  });

  it('names the shortfall when coverage starts after the period', () => {
    const line = coverageGapLine({
      periodStart: '2026-09-01', periodEnd: '2026-09-30',
      coveredFrom: '2026-09-14', sourceStatus: 'ok',
    });
    expect(line).toMatch(/2026-09-14/);
    expect(line).toMatch(/does not cover/i);
  });

  it('says the source is unmeasured, never that there were no incidents', () => {
    const line = coverageGapLine({ sourceStatus: 'not_connected' });
    expect(line).toMatch(/not connected/i);
    expect(line).not.toMatch(/\bno incidents\b/i);
  });

  it('says the source was never synced rather than implying a clean month', () => {
    const line = coverageGapLine({ sourceStatus: 'never_synced' });
    expect(line).toMatch(/never/i);
    expect(line).not.toMatch(/\bno incidents\b/i);
  });

  it('names the last sync when the source is stale, without nulling the period', () => {
    const line = coverageGapLine({
      periodStart: '2026-09-01', periodEnd: '2026-09-30',
      coveredFrom: '2026-09-01', coveredTo: '2026-09-20',
      sourceStatus: 'stale', lastSyncAt: '2026-09-20T05:00:00.000Z',
    });
    expect(line).toMatch(/2026-09-20/);
    expect(line).toMatch(/last synced/i);
    // A stale source still reports what it holds — the shortfall at the END of
    // the window is named too, which the not_connected branch never reaches.
    expect(line).toMatch(/does not cover/i);
    expect(line).not.toMatch(/\bno incidents\b/i);
  });

  it('still names an unknown last sync rather than printing an empty gap', () => {
    const line = coverageGapLine({ sourceStatus: 'stale' });
    expect(line).toMatch(/last synced/i);
    expect(line).toMatch(/unknown/i);
  });

  it('discloses withheld and unattributable counts', () => {
    const line = coverageGapLine({
      periodStart: '2026-09-01', periodEnd: '2026-09-30',
      coveredFrom: '2026-09-01', coveredTo: '2026-09-30', sourceStatus: 'ok',
      withheld: 50, unattributableExcluded: 3,
    });
    expect(line).toMatch(/50/);
    expect(line).toMatch(/3/);
  });
});
