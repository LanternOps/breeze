import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  executeMock,
  shouldProduceMlOutputMock,
  runOutsideDbContextMock,
  withSystemDbAccessContextMock,
  captureMessageMock,
} = vi.hoisted(() => ({
  executeMock: vi.fn(),
  shouldProduceMlOutputMock: vi.fn(),
  runOutsideDbContextMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(),
  captureMessageMock: vi.fn(),
}));

vi.mock('./sentry', () => ({
  captureMessage: captureMessageMock,
}));

vi.mock('../db', () => ({
  db: {
    execute: executeMock,
  },
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

vi.mock('./mlFeatureFlags', () => ({
  shouldProduceMlOutput: shouldProduceMlOutputMock,
}));

import {
  __resetMetricAnomalyStallTracking,
  METRIC_ANOMALY_LOCK_NAMESPACE,
  METRIC_ANOMALY_LOCK_TIMEOUT_MS,
  METRIC_ANOMALY_STATEMENT_TIMEOUT_MS,
  METRIC_ANOMALY_V1_SHADOW_VERSION,
  detectMetricAnomaliesRange,
} from './metricAnomalies';

/**
 * A Postgres driver error carries SQLSTATE on `.code`; `pgErrorCode` unwraps
 * that shape (directly or via `.cause`).
 */
function pgError(code: string): Error {
  return Object.assign(new Error(`simulated SQLSTATE ${code}`), { code });
}

/**
 * The detector statements, in execution order, with the per-stage preamble
 * (advisory-lock probe + the two `set_config` timeout statements) filtered out.
 *
 * Indexing `executeMock.mock.calls` directly stopped working in #5283: every
 * stage now issues three bookkeeping statements before its own, so a bare
 * `calls[3]` silently points at a `set_config` instead of the incident upsert
 * and every assertion against it passes vacuously.
 */
function detectorStatements(): string[] {
  return executeMock.mock.calls
    .map((call) => JSON.stringify(call))
    .filter((text) => text.includes('INSERT INTO'));
}

/** Reset the db mock to "lock acquired, no prior timeout to report". */
function resetDbMocks(): void {
  __resetMetricAnomalyStallTracking();
  captureMessageMock.mockReset();
  executeMock.mockReset();
  executeMock.mockResolvedValue([{ acquired: true }]);
  runOutsideDbContextMock.mockReset();
  runOutsideDbContextMock.mockImplementation((fn: () => unknown) => fn());
  withSystemDbAccessContextMock.mockReset();
  withSystemDbAccessContextMock.mockImplementation((fn: () => unknown) => fn());
}

describe('metric anomalies service', () => {
  beforeEach(() => {
    resetDbMocks();
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
      skippedReason: 'ml-disabled',
      stages: [],
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
    expect(result.stages.map((stage) => `${stage.stage}:${stage.outcome}`)).toEqual([
      'baseline:completed',
      'growth-trend:completed',
      'process-runaway:completed',
      'incidents:completed',
    ]);
    expect(detectorStatements()).toHaveLength(4);
    const executedSql = JSON.stringify(executeMock.mock.calls);
    expect(executedSql).toContain('INSERT INTO metric_anomalies');
    expect(executedSql).toContain('ON CONFLICT');
    expect(executedSql).toContain("WHERE metric_anomalies.status = 'open'");
    expect(executedSql).toContain('network_egress');
    expect(executedSql).toContain('memory_growth');

    const processStatementSql = detectorStatements()[2] ?? '';
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
    expect(detectorStatements()).toHaveLength(5);

    const v1StatementSql = detectorStatements()[4] ?? '';
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
// any of them, or a bulk detector re-upsert (the 10-min cron with a
// 15-min lookback revisits the trailing bucket twice) would silently re-publish an
// already-dispatched incident.
describe('metric anomaly incidents upsert (#3828 wave-6-4 task 2)', () => {
  beforeEach(() => {
    resetDbMocks();
    shouldProduceMlOutputMock.mockReset();
    shouldProduceMlOutputMock.mockImplementation(async (_orgId: string, flag: string) => flag === 'ml.anomalies.enabled');
  });

  it('upserts metric_anomaly_incidents from the org/range just detected, collapsed on (org_id, device_id, anomaly_type, bucket_seconds, window_start)', async () => {
    await detectMetricAnomaliesRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:30:00.000Z'),
    });

    expect(detectorStatements()).toHaveLength(4);
    const incidentSql = detectorStatements()[3] ?? '';

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

    const incidentSql = detectorStatements()[3] ?? '';
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

    const incidentSql = detectorStatements()[3] ?? '';
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

    const incidentSql = detectorStatements()[3] ?? '';
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

// #5283: enabling ml.anomalies.enabled put overlapping runs of the same
// baseline query against metric_rollups in a `Lock` wait for 29+ minutes,
// compounding until the feature had to be disabled. The guard has three parts,
// all asserted here: a per-org advisory lock so a second run SKIPS instead of
// queueing behind the first, one transaction per stage so a waiter can never be
// blocked by more than the single statement it conflicts with, and bounded lock
// /statement waits so a blocked stage gives the connection back.
describe('metric anomaly overlap guard (#5283)', () => {
  beforeEach(() => {
    resetDbMocks();
    shouldProduceMlOutputMock.mockReset();
    shouldProduceMlOutputMock.mockImplementation(async (_orgId: string, flag: string) => flag === 'ml.anomalies.enabled');
  });

  it('probes the per-org advisory lock before any detector statement, in every stage', async () => {
    await detectMetricAnomaliesRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:15:00.000Z'),
    });

    const texts = executeMock.mock.calls.map((call) => JSON.stringify(call));
    const lockProbes = texts.filter((text) => text.includes('pg_try_advisory_xact_lock'));
    // One per stage — the lock is transaction-scoped, so a single probe at the
    // top of the run would protect only the first stage's transaction.
    expect(lockProbes).toHaveLength(4);

    // `pg_try_advisory_*` never waits, so a contended run returns immediately
    // instead of joining the queue. A blocking `pg_advisory_xact_lock` here
    // would rebuild the pile-up with a different lock type.
    expect(texts.join('')).not.toContain('pg_advisory_xact_lock(');

    // Namespaced two-int form keyed on the org, so this can neither collide
    // with metricRollupMaintenance's single-int lock nor serialise unrelated orgs.
    expect(lockProbes[0]).toContain(String(METRIC_ANOMALY_LOCK_NAMESPACE));
    expect(lockProbes[0]).toContain('hashtext');
    expect(lockProbes[0]).toContain('11111111-1111-1111-1111-111111111111');

    // Ordering: the probe precedes the first detector statement.
    expect(texts.findIndex((text) => text.includes('pg_try_advisory_xact_lock')))
      .toBeLessThan(texts.findIndex((text) => text.includes('INSERT INTO')));
  });

  it('skips the run without throwing when another run holds the org lock', async () => {
    executeMock.mockResolvedValue([{ acquired: false }]);

    const result = await detectMetricAnomaliesRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:15:00.000Z'),
    });

    expect(result).toMatchObject({ skipped: true, skippedReason: 'locked', statements: 0 });
    // Stops at the first refusal: every later stage takes the SAME org key, so
    // probing them all would be four wasted round trips.
    expect(result.stages).toEqual([
      { stage: 'baseline', outcome: 'locked', durationMs: expect.any(Number) },
    ]);
    // The point of the whole change: a contended run issues NO upsert, so it
    // cannot land behind the winner's transactionid.
    expect(detectorStatements()).toHaveLength(0);
  });

  it('bounds lock and statement waits inside each stage, before the detector statement', async () => {
    await detectMetricAnomaliesRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:15:00.000Z'),
    });

    const texts = executeMock.mock.calls.map((call) => JSON.stringify(call));
    const lockTimeouts = texts.filter((text) => text.includes("'lock_timeout'"));
    const statementTimeouts = texts.filter((text) => text.includes("'statement_timeout'"));
    expect(lockTimeouts).toHaveLength(4);
    expect(statementTimeouts).toHaveLength(4);
    expect(lockTimeouts[0]).toContain(String(METRIC_ANOMALY_LOCK_TIMEOUT_MS));
    expect(statementTimeouts[0]).toContain(String(METRIC_ANOMALY_STATEMENT_TIMEOUT_MS));
    // `SET LOCAL` semantics (set_config's third arg), so the bound dies with
    // the stage's transaction and never leaks onto a pooled connection.
    expect(lockTimeouts[0]).toContain('set_config');
    expect(texts.findIndex((text) => text.includes("'statement_timeout'")))
      .toBeLessThan(texts.findIndex((text) => text.includes('INSERT INTO')));
  });

  it.each([
    ['55P03', 'lock_timeout'],
    ['57014', 'statement_timeout'],
  ])('skips only the stage that trips %s (%s) and keeps the run going', async (code) => {
    // Fail the FIRST detector statement; the advisory-lock probe and the two
    // set_config statements still succeed.
    let detectorCalls = 0;
    executeMock.mockImplementation(async (query: unknown) => {
      if (JSON.stringify(query).includes('INSERT INTO')) {
        detectorCalls += 1;
        if (detectorCalls === 1) throw pgError(code);
      }
      return [{ acquired: true }];
    });

    const result = await detectMetricAnomaliesRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:15:00.000Z'),
    });

    expect(result.stages[0]).toMatchObject({ stage: 'baseline', outcome: 'timeout', sqlState: code });
    // A timeout is per-statement, so the remaining stages still get their turn
    // — unlike `locked`, which stops the run.
    expect(result.stages.map((stage) => stage.outcome)).toEqual([
      'timeout',
      'completed',
      'completed',
      'completed',
    ]);
    expect(result).toMatchObject({ statements: 3, skipped: false });
  });

  it('reports skippedReason "timeout" when every stage trips its wait bound', async () => {
    executeMock.mockImplementation(async (query: unknown) => {
      if (JSON.stringify(query).includes('INSERT INTO')) throw pgError('57014');
      return [{ acquired: true }];
    });

    const result = await detectMetricAnomaliesRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:15:00.000Z'),
    });

    expect(result).toMatchObject({ skipped: true, skippedReason: 'timeout', statements: 0 });
  });

  it('propagates a non-timeout database error instead of silently skipping the stage', async () => {
    executeMock.mockImplementation(async (query: unknown) => {
      if (JSON.stringify(query).includes('INSERT INTO')) throw pgError('23505');
      return [{ acquired: true }];
    });

    await expect(
      detectMetricAnomaliesRange({
        orgId: '11111111-1111-1111-1111-111111111111',
        from: new Date('2026-06-18T12:00:00.000Z'),
        to: new Date('2026-06-18T12:15:00.000Z'),
      }),
    ).rejects.toThrow('23505');
  });

  it('opens a fresh system context per stage rather than one for the whole run', async () => {
    await detectMetricAnomaliesRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:15:00.000Z'),
    });

    const labels = withSystemDbAccessContextMock.mock.calls.map((call) => call[1]);
    // One transaction per detection stage. Before #5283 all four statements
    // shared ONE, so a waiting run blocked on the whole run's transactionid.
    expect(labels).toContain('metricAnomalies.baseline');
    expect(labels).toContain('metricAnomalies.growth-trend');
    expect(labels).toContain('metricAnomalies.process-runaway');
    expect(labels).toContain('metricAnomalies.incidents');

    // Every context is opened via runOutsideDbContext: withDbAccessContext
    // early-returns into an ambient context, so a caller that still wrapped the
    // whole run would otherwise collapse all four stages back into one
    // transaction with no error anywhere.
    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(
      withSystemDbAccessContextMock.mock.calls.length,
    );
  });

  it('reads ml flags in their own system context, so the RLS-scoped org read still resolves', async () => {
    await detectMetricAnomaliesRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:15:00.000Z'),
    });

    // loadMlFlagInputs reads `organizations` in the CALLER'S RLS context by
    // design (#2822). Splitting the per-stage transactions out of the old
    // single outer system context would otherwise leave this read contextless,
    // resolving every flag to org_not_found -> disabled and silently stopping
    // detection fleet-wide.
    expect(withSystemDbAccessContextMock.mock.calls.map((call) => call[1]))
      .toContain('metricAnomalies.flags');
  });
});

// Review follow-ups on #5283: the outcomes that only arise when stages
// INTERACT — a timeout followed by lock contention, and the shadow stage
// losing the lock while the main stages succeeded — plus the escalation that
// stops a permanently-skipping stage from being an invisible outage.
describe('metric anomaly skip reporting and stall escalation (#5283 review)', () => {
  const orgId = '11111111-1111-1111-1111-111111111111';
  const range = { from: new Date('2026-06-18T12:00:00.000Z'), to: new Date('2026-06-18T12:15:00.000Z') };

  beforeEach(() => {
    resetDbMocks();
    shouldProduceMlOutputMock.mockReset();
    shouldProduceMlOutputMock.mockImplementation(async (_orgId: string, flag: string) => flag === 'ml.anomalies.enabled');
  });

  /**
   * Drive per-stage outcomes by call order, cycling so the SAME programme
   * repeats for each successive `detectMetricAnomaliesRange` call — which is
   * what the consecutive-skip tests need. (A non-cycling counter runs off the
   * end of the array on run 2 and every stage silently succeeds, which is a
   * vacuous green.)
   */
  function programDetectors(outcomes: Array<'ok' | string>): void {
    let n = 0;
    executeMock.mockImplementation(async (query: unknown) => {
      const text = JSON.stringify(query);
      if (text.includes('pg_try_advisory_xact_lock')) {
        return [{ acquired: outcomes[n % outcomes.length] !== 'locked' }];
      }
      if (text.includes('INSERT INTO')) {
        const outcome = outcomes[n % outcomes.length];
        n += 1;
        if (outcome && outcome !== 'ok') throw pgError(outcome);
        return [];
      }
      return [{ acquired: true }];
    });
  }

  it('reports a timeout ahead of later lock contention, so the actionable failure is not masked', async () => {
    // baseline times out; growth-trend then loses the org lock to a racing
    // backfill. Reporting this as a benign `locked` would hide the timeout —
    // the one an operator actually has to act on.
    let detectorIndex = 0;
    executeMock.mockImplementation(async (query: unknown) => {
      const text = JSON.stringify(query);
      if (text.includes('pg_try_advisory_xact_lock')) {
        return [{ acquired: detectorIndex < 1 }];
      }
      if (text.includes('INSERT INTO')) {
        detectorIndex += 1;
        throw pgError('57014');
      }
      return [{ acquired: true }];
    });

    const result = await detectMetricAnomaliesRange({ orgId, ...range });

    expect(result.stages.map((stage) => `${stage.stage}:${stage.outcome}`)).toEqual([
      'baseline:timeout',
      'growth-trend:locked',
    ]);
    expect(result).toMatchObject({ skipped: true, skippedReason: 'timeout', statements: 0 });
  });

  it('does not mark the whole run skipped when only the v1 shadow stage loses the lock', async () => {
    shouldProduceMlOutputMock.mockResolvedValue(true);
    let detectorIndex = 0;
    executeMock.mockImplementation(async (query: unknown) => {
      const text = JSON.stringify(query);
      // Refuse the lock only for the 5th stage (v1-shadow).
      if (text.includes('pg_try_advisory_xact_lock')) return [{ acquired: detectorIndex < 4 }];
      if (text.includes('INSERT INTO')) {
        detectorIndex += 1;
        return [];
      }
      return [{ acquired: true }];
    });

    const result = await detectMetricAnomaliesRange({ orgId, ...range });

    expect(result).toMatchObject({
      statements: 4,
      v1ShadowStatements: 0,
      v1ShadowSkipped: true,
      skipped: false,
    });
    // The four main stages committed, so no skip reason may leak through.
    expect(result.skippedReason).toBeUndefined();
    expect(result.stages.map((stage) => stage.outcome)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
      'locked',
    ]);
  });

  it('escalates to Sentry once a stage has skipped three consecutive runs, tagged with org, stage and SQLSTATE', async () => {
    programDetectors(['57014', 'ok', 'ok', 'ok']);

    await detectMetricAnomaliesRange({ orgId, ...range });
    await detectMetricAnomaliesRange({ orgId, ...range });
    // One skip is expected and self-healing — it must NOT page anyone.
    expect(captureMessageMock).not.toHaveBeenCalled();

    await detectMetricAnomaliesRange({ orgId, ...range });

    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    expect(captureMessageMock).toHaveBeenCalledWith(
      expect.stringContaining('3 consecutive'),
      expect.objectContaining({
        eventCode: 'metric_anomaly_stage_stalled',
        tags: expect.objectContaining({
          org_id: orgId,
          metric_anomaly_stage: 'baseline',
          // Separates an administrative pg_cancel_backend from a real bound trip.
          pg_code: '57014',
        }),
      }),
    );
  });

  it('clears the stall counter when a stage recovers, so old skips cannot accumulate into a false alert', async () => {
    programDetectors(['57014', 'ok', 'ok', 'ok']);
    await detectMetricAnomaliesRange({ orgId, ...range });
    await detectMetricAnomaliesRange({ orgId, ...range });

    // A healthy run in between resets the streak...
    programDetectors(['ok', 'ok', 'ok', 'ok']);
    await detectMetricAnomaliesRange({ orgId, ...range });

    // ...so two further skips are still below the threshold.
    programDetectors(['57014', 'ok', 'ok', 'ok']);
    await detectMetricAnomaliesRange({ orgId, ...range });
    await detectMetricAnomaliesRange({ orgId, ...range });

    expect(captureMessageMock).not.toHaveBeenCalled();
  });
});
