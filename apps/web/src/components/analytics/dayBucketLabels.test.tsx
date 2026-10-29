import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatAxisLabel } from './ChartWidget';
import QueryBuilder, { type QueryResult } from './QueryBuilder';
import { fetchWithAuth } from '../../stores/auth';

// #10077: `/analytics/query` returns `interval: 'day'` buckets as UTC-midnight
// instants (`2026-10-22T00:00:00.000Z`). A day bucket is a calendar date, so
// it must label as Oct 22 in every zone — not Oct 21 west of UTC.
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

const ZONES = ['America/Los_Angeles', 'Europe/Berlin'] as const;
const shortDate = (y: number, m: number, d: number) =>
  new Date(y, m, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

const originalTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = originalTz;
});

const dayBucketResponse = (timestamps: string[]): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      series: [
        {
          metric: 'CPU Utilization',
          data: timestamps.map((timestamp, i) => ({ timestamp, value: 10 + i }))
        }
      ]
    })
  }) as unknown as Response;

async function runQuery(timeRange: '24h' | '7d'): Promise<QueryResult> {
  const onQueryResult = vi.fn<(result: QueryResult) => void>();
  render(
    <QueryBuilder
      deviceIds={['dev-1']}
      value={{ metricType: 'performance', metricName: 'CPU Utilization', aggregation: 'avg', timeRange }}
      onQueryResult={onQueryResult}
    />
  );
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(onQueryResult).toHaveBeenCalledTimes(1));
  return onQueryResult.mock.calls[0][0];
}

describe.each(ZONES)('Query Builder day buckets keep their calendar date (TZ=%s, #10077)', zone => {
  beforeEach(() => {
    process.env.TZ = zone;
    fetchMock.mockReset();
  });

  it('formatAxisLabel renders a bare YYYY-MM-DD as that calendar day', () => {
    expect(formatAxisLabel('2026-10-22')).toBe(shortDate(2026, 9, 22));
    expect(formatAxisLabel('2026-01-01')).toBe(shortDate(2026, 0, 1));
  });

  it('formatAxisLabel still renders a full instant in local time', () => {
    const instant = '2026-10-22T12:00:00.000Z';
    expect(formatAxisLabel(instant)).toBe(
      new Date(instant).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    );
  });

  it('a day-interval query hands the chart date-only buckets that label as the bucket date', async () => {
    fetchMock.mockResolvedValueOnce(
      dayBucketResponse(['2026-10-22T00:00:00.000Z', '2026-10-23T00:00:00.000Z', '2026-10-25T00:00:00Z'])
    );
    const result = await runQuery('7d');

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.interval).toBe('day');
    expect(result.interval).toBe('day');

    const data = (result.series[0] as { data: Array<{ timestamp: string }> }).data;
    expect(data.map(p => p.timestamp)).toEqual(['2026-10-22', '2026-10-23', '2026-10-25']);
    expect(data.map(p => formatAxisLabel(p.timestamp))).toEqual([
      shortDate(2026, 9, 22),
      shortDate(2026, 9, 23),
      shortDate(2026, 9, 25)
    ]);
  });

  it('an hour-interval query keeps instant timestamps', async () => {
    fetchMock.mockResolvedValueOnce(dayBucketResponse(['2026-10-22T07:00:00.000Z']));
    const result = await runQuery('24h');
    expect(result.interval).toBe('hour');
    const data = (result.series[0] as { data: Array<{ timestamp: string }> }).data;
    expect(data[0].timestamp).toBe('2026-10-22T07:00:00.000Z');
  });
});
