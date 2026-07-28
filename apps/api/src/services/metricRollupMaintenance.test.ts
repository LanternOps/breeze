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

  it('ensures monthly partitions through the SECURITY DEFINER function, one call per month', async () => {
    executeMock
      .mockResolvedValueOnce([{ partitionName: 'metric_rollups_y2026m06' }])
      .mockResolvedValueOnce([{ partitionName: 'metric_rollups_y2026m07' }]);

    const ensured = await ensureMetricRollupPartitions({
      referenceDate: new Date('2026-06-18T12:00:00.000Z'),
      monthsBack: 0,
      monthsAhead: 1,
    });

    expect(ensured).toEqual(['metric_rollups_y2026m06', 'metric_rollups_y2026m07']);
    // One call per month, not the 24 statements the inline DDL used to issue.
    expect(executeMock).toHaveBeenCalledTimes(2);

    const executedSql = JSON.stringify(executeMock.mock.calls);
    expect(executedSql).toContain('public.breeze_ensure_metric_rollup_partition');
    expect(executedSql).toContain('2026-06-01 00:00:00');
    expect(executedSql).toContain('2026-07-01 00:00:00');
    // The DDL must NOT be issued from the app connection — that is the bug
    // (BREEZE-10): breeze_app has no CREATE on schema public and owns neither
    // metric_rollups nor its children, so every one of these aborted the run.
    expect(executedSql).not.toContain('PARTITION OF metric_rollups');
    expect(executedSql).not.toContain('ENABLE ROW LEVEL SECURITY');
    expect(executedSql).not.toContain('CREATE POLICY');
    expect(executedSql).not.toContain('GRANT SELECT, INSERT, UPDATE, DELETE');
  });

  it('treats a NULL partition name as a default-partition overlap skip', async () => {
    executeMock
      .mockResolvedValueOnce([{ partitionName: null }])
      .mockResolvedValueOnce([{ partitionName: 'metric_rollups_y2026m07' }]);

    const ensured = await ensureMetricRollupPartitions({
      referenceDate: new Date('2026-06-18T12:00:00.000Z'),
      monthsBack: 0,
      monthsAhead: 1,
    });

    expect(ensured).toEqual(['metric_rollups_y2026m07']);
  });

  it('throws rather than silently skipping when the maintenance function is missing', async () => {
    // A DB that has not applied migration 2026-08-05 returns no such column.
    // Swallowing that would turn a broken deployment into an invisible no-op.
    executeMock.mockResolvedValueOnce([]);

    await expect(
      ensureMetricRollupPartitions({
        referenceDate: new Date('2026-06-18T12:00:00.000Z'),
        monthsBack: 0,
        monthsAhead: 0,
      }),
    ).rejects.toThrow(/partitionName column/);
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
      .mockResolvedValueOnce([{ partitionName: 'metric_rollups_y2022m12' }]);

    const dropped = await dropExpiredMetricRollupPartitions(new Date('2026-06-18T12:00:00.000Z'));

    expect(dropped).toEqual(['metric_rollups_y2022m12']);
    expect(executeMock).toHaveBeenCalledTimes(2);
    const dropSql = JSON.stringify(executeMock.mock.calls[1]);
    // Owner-only DDL goes through the SECURITY DEFINER seam, and it receives the
    // month rather than the discovered identifier — so the function re-derives
    // and re-verifies attachment, keeping metric_rollups_default unreachable.
    expect(dropSql).toContain('public.breeze_drop_metric_rollup_partition');
    expect(dropSql).toContain('2022-12-01 00:00:00');
    expect(dropSql).not.toContain('DROP TABLE');
  });

  it('does not report a drop when nothing was attached for that month', async () => {
    executeMock
      .mockResolvedValueOnce([{ partitionName: 'metric_rollups_y2022m12' }])
      .mockResolvedValueOnce([{ partitionName: null }]);

    const dropped = await dropExpiredMetricRollupPartitions(new Date('2026-06-18T12:00:00.000Z'));

    expect(dropped).toEqual([]);
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
