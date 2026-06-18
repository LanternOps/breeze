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
