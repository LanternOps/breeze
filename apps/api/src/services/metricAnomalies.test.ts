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

import { detectMetricAnomaliesRange } from './metricAnomalies';

describe('metric anomalies service', () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue([]);
    shouldProduceMlOutputMock.mockReset();
    shouldProduceMlOutputMock.mockResolvedValue(true);
  });

  it('gates all writes behind the anomaly ML feature flag', async () => {
    shouldProduceMlOutputMock.mockResolvedValue(false);

    const result = await detectMetricAnomaliesRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:30:00.000Z'),
    });

    expect(result).toEqual({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: '2026-06-18T12:00:00.000Z',
      to: '2026-06-18T12:30:00.000Z',
      statements: 0,
      skipped: true,
    });
    expect(shouldProduceMlOutputMock).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111',
      'ml.anomalies.enabled',
    );
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('upserts baseline deviations and growth trends idempotently', async () => {
    const result = await detectMetricAnomaliesRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:30:00.000Z'),
    });

    expect(result).toMatchObject({ statements: 2, skipped: false });
    expect(executeMock).toHaveBeenCalledTimes(2);
    const executedSql = JSON.stringify(executeMock.mock.calls);
    expect(executedSql).toContain('INSERT INTO metric_anomalies');
    expect(executedSql).toContain('ON CONFLICT');
    expect(executedSql).toContain("WHERE metric_anomalies.status = 'open'");
    expect(executedSql).toContain('network_egress');
    expect(executedSql).toContain('memory_growth');
  });

  it('rejects invalid ranges before executing writes', async () => {
    await expect(
      detectMetricAnomaliesRange({
        orgId: '11111111-1111-1111-1111-111111111111',
        from: new Date('2026-06-18T13:00:00.000Z'),
        to: new Date('2026-06-18T12:00:00.000Z'),
      }),
    ).rejects.toThrow('from < to');
    expect(executeMock).not.toHaveBeenCalled();
  });
});
