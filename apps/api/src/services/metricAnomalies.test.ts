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

  it('upserts baseline deviations, growth trends, process sample runaways, and the collapsed incident row idempotently', async () => {
    const result = await detectMetricAnomaliesRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:30:00.000Z'),
    });

    expect(result).toMatchObject({ statements: 4, skipped: false });
    expect(result).toMatchObject({ v1ShadowStatements: 0, v1ShadowSkipped: true });
    expect(executeMock).toHaveBeenCalledTimes(4);
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
      statements: 4,
      v1ShadowStatements: 1,
      v1ShadowSkipped: false,
      skipped: false,
    });
    // 3 detectors + the incident upsert (always) + the v1 shadow statement.
    expect(executeMock).toHaveBeenCalledTimes(5);

    const v1StatementSql = JSON.stringify(executeMock.mock.calls[4]);
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

// Wave 6 PR 4 (#3828) Task 2: the fourth statement collapses sibling
// metric_anomalies rows into metric_anomaly_incidents. The DO UPDATE SET-list
// assertion here is the load-bearing re-publish guard the plan calls for —
// dispatched_at/dispatch_attempts/agent_run_id are the transactional dispatch
// marker (metricAnomalyIncidents.ts), and this statement must NEVER assign
// any of them, or a bulk detector re-upsert (the 10-min/30-min-lookback
// schedule revisits every row ~3x) would silently re-publish an
// already-dispatched incident.
describe('metric anomaly incidents upsert (#3828 wave-6-4 task 2)', () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue([]);
    shouldProduceMlOutputMock.mockReset();
    shouldProduceMlOutputMock.mockImplementation(async (_orgId: string, flag: string) => flag === 'ml.anomalies.enabled');
  });

  it('upserts metric_anomaly_incidents from the org/range just detected, collapsed on (org_id, device_id, anomaly_type, bucket_seconds, window_start)', async () => {
    await detectMetricAnomaliesRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:30:00.000Z'),
    });

    expect(executeMock).toHaveBeenCalledTimes(4);
    const incidentSql = JSON.stringify(executeMock.mock.calls[3]);

    expect(incidentSql).toContain('INSERT INTO metric_anomaly_incidents');
    expect(incidentSql).toContain('FROM metric_anomalies');
    expect(incidentSql).toContain("ma.status = 'open'");
    // Collapsing key matches the table's unique index exactly, metric_name
    // deliberately excluded (mirrors metricAnomalyPromotion.ts's
    // findDedupeSiblings) — pinned as the literal clause, not just a
    // substring search, so a stray extra/missing column is caught.
    expect(incidentSql).toContain(
      'GROUP BY ma.org_id, ma.device_id, ma.anomaly_type, ma.bucket_seconds, ma.window_start',
    );
    expect(incidentSql).toContain(
      'ON CONFLICT (org_id, device_id, anomaly_type, bucket_seconds, window_start)',
    );
    // metric_name still appears, but only folded into the array_agg — never
    // as a grouping/conflict column.
    expect(incidentSql).toContain('array_agg(DISTINCT ma.metric_name');
  });

  it('re-publish guard: the DO UPDATE SET list never assigns dispatched_at, dispatch_attempts, or agent_run_id', async () => {
    await detectMetricAnomaliesRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:30:00.000Z'),
    });

    const incidentSql = JSON.stringify(executeMock.mock.calls[3]);
    // The statement never references these columns at all (not in the
    // INSERT column list, not in SELECT, not in SET) — so a future edit that
    // starts refreshing the dispatch marker on every re-detect (the exact
    // re-publish bug this design exists to prevent) fails here first.
    expect(incidentSql).not.toContain('dispatched_at');
    expect(incidentSql).not.toContain('dispatch_attempts');
    expect(incidentSql).not.toContain('agent_run_id');
    // The columns it DOES refresh on conflict.
    expect(incidentSql).toContain('last_seen_at = EXCLUDED.last_seen_at');
    expect(incidentSql).toContain('GREATEST(metric_anomaly_incidents.peak_score, EXCLUDED.peak_score)');
    expect(incidentSql).toContain('row_count = EXCLUDED.row_count');
    expect(incidentSql).toContain('metric_names = EXCLUDED.metric_names');
    // first_seen_at is likewise never refreshed on conflict — it should
    // stay pinned to the incident's original first-detected timestamp.
    expect(incidentSql).not.toContain('first_seen_at = EXCLUDED.first_seen_at');
  });

  it('filters on window_end (not window_start), with no upper bound against `to`', async () => {
    await detectMetricAnomaliesRange({
      orgId: '22222222-2222-2222-2222-222222222222',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:30:00.000Z'),
    });

    const incidentCall = executeMock.mock.calls[3];
    const incidentSql = JSON.stringify(incidentCall);
    // window_end, not window_start: a growth-trend row's window_start is the
    // START of its multi-bucket trend window and can predate `from`, but
    // every detector writes window_end >= its own bucket_start >= `from`, so
    // filtering on window_end (rather than window_start) is what keeps every
    // row this pass just wrote in range — see the comment above
    // upsertMetricAnomalyIncidents for the arithmetic.
    expect(incidentSql).toContain('ma.window_end >=');
    expect(incidentSql).toContain('2026-06-18T12:00:00.000Z');
    expect(incidentSql).not.toContain('ma.window_start >=');
    // No upper-bound comparison against `to` for metric_anomalies.window_end
    // — an incident keeps collapsing across later revisit passes instead of
    // falling out of range once its window_end ages past a subsequent
    // pass's `from`.
    expect(incidentSql).not.toContain('ma.window_end <');
  });

  it('includes a growth-trend row whose window_start predates `from` (window_end is what gates it, and is still >= from)', async () => {
    await detectMetricAnomaliesRange({
      orgId: '33333333-3333-3333-3333-333333333333',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:30:00.000Z'),
    });

    const incidentCall = executeMock.mock.calls[3];
    const incidentSql = JSON.stringify(incidentCall);
    // `ma.window_start` legitimately appears in SELECT and GROUP BY (it's
    // the collapsing key), so assert on the WHERE-clause predicate shape
    // specifically: no comparison operator is ever applied to
    // `ma.window_start` anywhere in the statement. A growth-trend row with,
    // e.g., window_start = 2026-06-18T11:35:00.000Z (25 minutes before
    // `from`, the MIN_TREND_BUCKETS lookback) and
    // window_end = 2026-06-18T12:05:00.000Z (still >= `from`) is included by
    // the actual filter (window_end >= from) and would have been wrongly
    // excluded by a window_start >= from filter.
    expect(incidentSql).not.toMatch(/ma\.window_start\s*(>=|<=|>|<)/);
  });

  it('is gated by the same ml.anomalies.enabled flag as the rest of the detect job', async () => {
    shouldProduceMlOutputMock.mockResolvedValue(false);

    const result = await detectMetricAnomaliesRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:30:00.000Z'),
    });

    expect(result).toMatchObject({ statements: 0, skipped: true });
    expect(executeMock).not.toHaveBeenCalled();
  });
});
