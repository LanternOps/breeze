import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    execute: executeMock,
  },
}));

import {
  deleteExpiredMetricRollupsForBucket,
  dropExpiredMetricRollupPartitions,
  ensureMetricRollupPartitions,
  metricRollupPartitionName,
  parseMetricRollupPartitionMonth,
  runMetricRollupMaintenance,
} from './metricRollupMaintenance';

describe('metric rollup maintenance service', () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue([]);
  });

  it('uses deterministic month partition names', () => {
    expect(metricRollupPartitionName(new Date('2026-06-18T12:00:00.000Z'))).toBe('metric_rollups_y2026m06');
    expect(parseMetricRollupPartitionMonth('metric_rollups_y2026m06')?.toISOString()).toBe(
      '2026-06-01T00:00:00.000Z',
    );
    expect(parseMetricRollupPartitionMonth('metric_rollups_default')).toBeNull();
  });

  it('creates monthly partitions with RLS policies and breeze_app grants', async () => {
    await ensureMetricRollupPartitions({
      referenceDate: new Date('2026-06-18T12:00:00.000Z'),
      monthsBack: 0,
      monthsAhead: 1,
    });

    const executedSql = JSON.stringify(executeMock.mock.calls);
    expect(executeMock).toHaveBeenCalledTimes(24);
    expect(executedSql).toContain('metric_rollups_y2026m06');
    expect(executedSql).toContain('metric_rollups_y2026m07');
    expect(executedSql).toContain('PARTITION OF metric_rollups');
    expect(executedSql).toContain('FOR VALUES FROM');
    expect(executedSql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(executedSql).toContain('FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id))');
    expect(executedSql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE');
  });

  it('uses tableoid and ctid for bounded deletes through the partitioned parent', async () => {
    executeMock.mockResolvedValueOnce({ rowCount: 5000 }).mockResolvedValueOnce({ rowCount: 25 });

    const result = await deleteExpiredMetricRollupsForBucket({
      bucketSeconds: 300,
      cutoff: new Date('2026-03-20T00:00:00.000Z'),
      batchSize: 5000,
      maxBatches: 3,
    });

    expect(result).toEqual({ deleted: 5025, batches: 2, hasMore: false });
    const executedSql = JSON.stringify(executeMock.mock.calls);
    expect(executedSql).toContain('SELECT tableoid, ctid');
    expect(executedSql).toContain('mr.tableoid = doomed.tableoid');
    expect(executedSql).toContain('mr.ctid = doomed.ctid');
    expect(executedSql).toContain('ORDER BY bucket_start');
    expect(executedSql).toContain('LIMIT');
  });

  it('reports hasMore when bounded deletes stop at the configured batch cap', async () => {
    executeMock.mockResolvedValue({ rowCount: 100 });

    const result = await deleteExpiredMetricRollupsForBucket({
      bucketSeconds: 3600,
      cutoff: new Date('2025-01-01T00:00:00.000Z'),
      batchSize: 100,
      maxBatches: 2,
    });

    expect(result).toEqual({ deleted: 200, batches: 2, hasMore: true });
  });

  it('drops only managed partitions whose whole month is past the daily retention window', async () => {
    executeMock
      .mockResolvedValueOnce([
        { partitionName: 'metric_rollups_y2022m12' },
        { partitionName: 'metric_rollups_y2026m06' },
        { partitionName: 'metric_rollups_default' },
      ])
      .mockResolvedValueOnce({ rowCount: 0 });

    const dropped = await dropExpiredMetricRollupPartitions(new Date('2026-06-18T12:00:00.000Z'));

    expect(dropped).toEqual(['metric_rollups_y2022m12']);
    expect(executeMock).toHaveBeenCalledTimes(2);
    const dropSql = JSON.stringify(executeMock.mock.calls[1]);
    expect(dropSql).toContain('DROP TABLE IF EXISTS');
    expect(dropSql).toContain('metric_rollups_y2022m12');
  });

  it('skips maintenance when another worker holds the advisory lock', async () => {
    executeMock.mockResolvedValueOnce([{ acquired: false }]);

    const result = await runMetricRollupMaintenance({ now: new Date('2026-06-18T12:00:00.000Z') });

    expect(result).toMatchObject({
      skipped: true,
      reason: 'maintenance lock already held',
      ensuredPartitions: [],
      droppedPartitions: [],
      retention: [],
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});
