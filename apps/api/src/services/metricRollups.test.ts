import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock, shouldProduceMlOutputMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  shouldProduceMlOutputMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    execute: executeMock,
  },
}));

vi.mock('./mlFeatureFlags', () => ({
  shouldProduceMlOutput: shouldProduceMlOutputMock,
}));

import { rollupDeviceMetricsRange } from './metricRollups';

describe('metric rollups service', () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue([]);
    shouldProduceMlOutputMock.mockReset();
    shouldProduceMlOutputMock.mockResolvedValue(true);
  });

  it('gates all writes behind the metric rollups ML feature flag', async () => {
    shouldProduceMlOutputMock.mockResolvedValue(false);

    const result = await rollupDeviceMetricsRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:15:00.000Z'),
    });

    expect(result).toEqual({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: '2026-06-18T12:00:00.000Z',
      to: '2026-06-18T12:15:00.000Z',
      statements: 0,
      skipped: true,
    });
    expect(shouldProduceMlOutputMock).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111',
      'ml.metric_rollups.enabled',
    );
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('upserts raw 5-minute buckets and derived hourly/daily buckets idempotently', async () => {
    const result = await rollupDeviceMetricsRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T13:00:00.000Z'),
    });

    expect(result).toMatchObject({ statements: 12, skipped: false });
    expect(executeMock).toHaveBeenCalledTimes(12);
    const executedSql = JSON.stringify(executeMock.mock.calls);
    expect(executedSql).toContain('ON CONFLICT');
    expect(executedSql).toContain('percentile_cont(0.95)');
    expect(executedSql).toContain('NULL::double precision');
  });

  it('materializes regular raw bucket grids so sparse heartbeats create gap buckets', async () => {
    await rollupDeviceMetricsRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:15:00.000Z'),
      expectedSampleSeconds: 60,
    });

    const rawStatementSql = JSON.stringify(executeMock.mock.calls[0]);
    expect(rawStatementSql).toContain('generate_series');
    expect(rawStatementSql).toContain('bucket_grid');
    expect(rawStatementSql).toContain('LEFT JOIN device_metrics');
    expect(rawStatementSql).toContain('count(');
    expect(rawStatementSql).toContain('dm.cpu_percent');
    expect(rawStatementSql).toContain('isGap');
    expect(rawStatementSql).toContain('DO UPDATE SET');
  });

  it('lets derived rollups include gap buckets without averaging empty values', async () => {
    await rollupDeviceMetricsRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T13:00:00.000Z'),
    });

    const hourlyStatementSql = JSON.stringify(executeMock.mock.calls[10]);
    expect(hourlyStatementSql).toContain('sum(mr.avg_value * mr.sample_count)');
    expect(hourlyStatementSql).toContain('sum(mr.gap_seconds)');
    expect(hourlyStatementSql).not.toContain('AND mr.sample_count > 0');
    expect(hourlyStatementSql).toContain('HAVING sum(mr.sample_count) > 0');
  });

  it('rejects invalid ranges before executing writes', async () => {
    await expect(
      rollupDeviceMetricsRange({
        orgId: '11111111-1111-1111-1111-111111111111',
        from: new Date('2026-06-18T13:00:00.000Z'),
        to: new Date('2026-06-18T12:00:00.000Z'),
      }),
    ).rejects.toThrow('from < to');
    expect(executeMock).not.toHaveBeenCalled();
  });
});
