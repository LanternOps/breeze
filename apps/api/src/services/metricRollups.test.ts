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

    expect(result).toMatchObject({ statements: 24, skipped: false });
    expect(executeMock).toHaveBeenCalledTimes(24);
    const executedSql = JSON.stringify(executeMock.mock.calls);
    expect(executedSql).toContain('ON CONFLICT');
    expect(executedSql).toContain('percentile_cont(0.95)');
    expect(executedSql).toContain('NULL::double precision');
    expect(executedSql).toContain('device_process_samples');
    expect(executedSql).toContain('snmp_metrics');
    expect(executedSql).toContain('jsonb_array_elements');
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

  it('bounds the raw device_metrics join to the rollup window (incident 2026-06-21: prevents full per-device history scan)', async () => {
    await rollupDeviceMetricsRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:15:00.000Z'),
    });

    // The raw device statement is the first execute() call. Its LEFT JOIN must
    // carry an explicit [from,to) bound in addition to the per-bucket bound;
    // without it the generate_series-derived bucket_start predicate is
    // non-sargable and Postgres bitmap-scans each device's entire history.
    const rawDeviceSql = JSON.stringify(executeMock.mock.calls[0]);
    expect(rawDeviceSql).toContain('LEFT JOIN device_metrics');
    expect(rawDeviceSql).toContain('join window bound');
  });

  it('lets derived rollups include gap buckets without averaging empty values', async () => {
    await rollupDeviceMetricsRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T13:00:00.000Z'),
    });

    const hourlyStatementSql = JSON.stringify(executeMock.mock.calls[18]);
    expect(hourlyStatementSql).toContain('sum(mr.avg_value * mr.sample_count)');
    expect(hourlyStatementSql).toContain('sum(mr.gap_seconds)');
    expect(hourlyStatementSql).not.toContain('AND mr.sample_count > 0');
    expect(hourlyStatementSql).toContain('HAVING sum(mr.sample_count) > 0');
  });

  it('rolls up top process sample metrics from JSON process payloads', async () => {
    await rollupDeviceMetricsRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:15:00.000Z'),
    });

    const processStatementSql = JSON.stringify(executeMock.mock.calls[10]);
    expect(processStatementSql).toContain('device_process_samples');
    expect(processStatementSql).toContain('process_devices');
    expect(processStatementSql).toContain('sample_values');
    expect(processStatementSql).toContain('top_process_count');
    expect(processStatementSql).toContain('jsonb_array_length(dps.top_processes)');
    expect(processStatementSql).toContain("'process'");

    const processCpuStatementSql = JSON.stringify(executeMock.mock.calls[11]);
    expect(processCpuStatementSql).toContain('top_process_cpu_percent_sum');
    expect(processCpuStatementSql).toContain('jsonb_array_elements(dps.top_processes)');
    expect(processCpuStatementSql).toContain("proc.value -> 'cpu'");

    const processCpuMaxStatementSql = JSON.stringify(executeMock.mock.calls[12]);
    expect(processCpuMaxStatementSql).toContain('top_process_cpu_percent_max');
    expect(processCpuMaxStatementSql).toContain('max(');

    const processRamMaxStatementSql = JSON.stringify(executeMock.mock.calls[14]);
    expect(processRamMaxStatementSql).toContain('top_process_ram_mb_max');
    expect(processRamMaxStatementSql).toContain("proc.value -> 'ramMb'");

    const processHourlyStatementSql = JSON.stringify(executeMock.mock.calls[20]);
    expect(processHourlyStatementSql).toContain('device_process_samples');
    expect(processHourlyStatementSql).toContain('sourceBucketSeconds');
  });

  it('rolls up numeric SNMP metrics for SNMP assets linked to managed devices', async () => {
    await rollupDeviceMetricsRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:15:00.000Z'),
    });

    const snmpStatementSql = JSON.stringify(executeMock.mock.calls[17]);
    expect(snmpStatementSql).toContain('snmp_metrics');
    expect(snmpStatementSql).toContain('snmp_devices');
    expect(snmpStatementSql).toContain('discovered_assets');
    expect(snmpStatementSql).toContain('da.linked_device_id');
    expect(snmpStatementSql).toContain('JOIN devices');
    expect(snmpStatementSql).toContain("btrim(sm.value) ~ '^-?[0-9]+");
    expect(snmpStatementSql).toContain("'snmp_metrics'");
    expect(snmpStatementSql).toContain("'snmp'");
    expect(snmpStatementSql).toContain('snmpDeviceId');
    expect(snmpStatementSql).toContain('displayName');

    const snmpHourlyStatementSql = JSON.stringify(executeMock.mock.calls[22]);
    expect(snmpHourlyStatementSql).toContain('snmp_metrics');
    expect(snmpHourlyStatementSql).toContain('sourceBucketSeconds');
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
