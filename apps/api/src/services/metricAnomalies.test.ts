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

import { METRIC_ANOMALY_V1_SHADOW_VERSION, detectMetricAnomaliesRange } from './metricAnomalies';

describe('metric anomalies service', () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue([]);
    shouldProduceMlOutputMock.mockReset();
    shouldProduceMlOutputMock.mockImplementation(async (_orgId: string, flag: string) => flag === 'ml.anomalies.enabled');
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

  it('upserts baseline deviations, growth trends, and process sample runaways idempotently', async () => {
    const result = await detectMetricAnomaliesRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:30:00.000Z'),
    });

    expect(result).toMatchObject({ statements: 3, skipped: false });
    expect(result).toMatchObject({ v1ShadowStatements: 0, v1ShadowSkipped: true });
    expect(executeMock).toHaveBeenCalledTimes(3);
    const executedSql = JSON.stringify(executeMock.mock.calls);
    expect(executedSql).toContain('INSERT INTO metric_anomalies');
    expect(executedSql).toContain('ON CONFLICT');
    expect(executedSql).toContain("WHERE metric_anomalies.status = 'open'");
    expect(executedSql).toContain('network_egress');
    expect(executedSql).toContain('memory_growth');

    const processStatementSql = JSON.stringify(executeMock.mock.calls[2]);
    expect(processStatementSql).toContain("mr.source_table = 'device_process_samples'");
    expect(processStatementSql).toContain('top_process_cpu_percent_sum');
    expect(processStatementSql).toContain('top_process_cpu_percent_max');
    expect(processStatementSql).toContain('top_process_ram_mb_sum');
    expect(processStatementSql).toContain('top_process_ram_mb_max');
    expect(processStatementSql).toContain('top_process_disk_bps_sum');
    expect(processStatementSql).toContain('top_process_net_bps_sum');
    expect(processStatementSql).toContain('process_sample_runaway');
    expect(processStatementSql).toContain('process_runaway');
    expect(processStatementSql).toContain('network_egress');
  });

  it('runs the v1 seasonal robust shadow scorer only when the shadow flag is enabled', async () => {
    shouldProduceMlOutputMock.mockImplementation(async (_orgId: string, flag: string) =>
      flag === 'ml.anomalies.enabled' || flag === 'ml.anomalies.v1_shadow.enabled',
    );

    const result = await detectMetricAnomaliesRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:30:00.000Z'),
    });

    expect(result).toMatchObject({
      statements: 3,
      v1ShadowStatements: 1,
      v1ShadowSkipped: false,
      skipped: false,
    });
    expect(executeMock).toHaveBeenCalledTimes(4);

    const v1StatementSql = JSON.stringify(executeMock.mock.calls[3]);
    expect(v1StatementSql).toContain('INSERT INTO metric_anomaly_candidates');
    expect(v1StatementSql).toContain(METRIC_ANOMALY_V1_SHADOW_VERSION);
    expect(v1StatementSql).toContain('percentile_cont');
    expect(v1StatementSql).toContain('mad_value');
    expect(v1StatementSql).toContain('baseline_active_days');
    expect(v1StatementSql).toContain('baseline_first_bucket');
    expect(v1StatementSql).toContain('readinessState');
    expect(v1StatementSql).toContain('minBaselineSpanDays');
    expect(v1StatementSql).toContain('minBaselineActiveDays');
    expect(v1StatementSql).toContain('ON CONFLICT');
    expect(v1StatementSql).not.toContain('INSERT INTO metric_anomalies');
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
