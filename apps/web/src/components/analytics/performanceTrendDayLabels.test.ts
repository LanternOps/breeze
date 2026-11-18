import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { normalizePerformanceData } from './AnalyticsPage';
import { formatAxisLabel } from './ChartWidget';

// #10937: `/metrics/trends` returns day buckets as UTC-midnight instants. A day
// bucket is a calendar date, so the Performance Trend chart must label it with
// that date in every zone — not the previous day west of UTC.
const ZONES = ['America/Los_Angeles', 'America/Denver', 'Europe/Berlin'] as const;
const shortDate = (y: number, m: number, d: number) =>
  new Date(y, m, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe.each(ZONES)('Performance Trend day buckets (TZ=%s, #10937)', zone => {
  beforeEach(() => {
    process.env.TZ = zone;
  });

  it('labels UTC-midnight buckets with their own calendar day', () => {
    const points = normalizePerformanceData({
      cpu: [{ timestamp: '2026-11-02T00:00:00.000Z', value: 10 }],
      memory: [{ timestamp: '2026-11-02T00:00:00.000Z', value: 20 }]
    });
    expect(points).toHaveLength(1);
    expect(formatAxisLabel(points[0]!.timestamp)).toBe(shortDate(2026, 10, 2));
  });

  it('applies to the flat row shape too', () => {
    const points = normalizePerformanceData([
      { timestamp: '2026-11-02T00:00:00.000Z', cpu: 5, memory: 6 },
      { timestamp: '2026-11-03T00:00:00Z', cpu: 7, memory: 8 }
    ]);
    expect(points.map(p => formatAxisLabel(p.timestamp))).toEqual([
      shortDate(2026, 10, 2),
      shortDate(2026, 10, 3)
    ]);
  });

  it('leaves non-midnight instants and non-date labels alone', () => {
    const points = normalizePerformanceData([
      { timestamp: '2026-11-02T07:00:00.000Z', cpu: 1, memory: 1 },
      { label: 'Week 3', cpu: 2, memory: 2 }
    ]);
    expect(points.map(p => p.timestamp)).toEqual(['2026-11-02T07:00:00.000Z', 'Week 3']);
  });
});
