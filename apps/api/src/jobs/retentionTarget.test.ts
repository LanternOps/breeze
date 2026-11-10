import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const m = vi.hoisted(() => ({
  countEligibleRows: vi.fn(),
  pruneInCtidBatches: vi.fn(),
  updateInCtidBatches: vi.fn(),
  warnOnRetentionBacklog: vi.fn(),
  recordRetentionRun: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('./retentionBatch', async (importOriginal) => ({
  // Keep the real utcWallTime so predicates render as they will in production.
  ...(await importOriginal<typeof import('./retentionBatch')>()),
  countEligibleRows: (...a: unknown[]) => m.countEligibleRows(...a),
  pruneInCtidBatches: (...a: unknown[]) => m.pruneInCtidBatches(...a),
  updateInCtidBatches: (...a: unknown[]) => m.updateInCtidBatches(...a),
  warnOnRetentionBacklog: (...a: unknown[]) => m.warnOnRetentionBacklog(...a),
}));
vi.mock('../services/retentionMetrics', () => ({
  recordRetentionRun: (...a: unknown[]) => m.recordRetentionRun(...a),
}));
vi.mock('../services/sentry', () => ({
  captureException: (...a: unknown[]) => m.captureException(...a),
}));

import { utcWallTime } from './retentionBatch';
import { runRetentionTarget, runRetentionTargets, type RetentionKnobs, type RetentionTarget } from './retentionTarget';

const dialect = new PgDialect();
const render = (q: SQL) => {
  const out = dialect.sqlToQuery(q);
  return { sql: out.sql, params: out.params as unknown[] };
};

const NOW = new Date('2026-11-09T12:34:56.789Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const whereSpy = vi.fn((cutoffIso: string, nowIso: string) =>
  sql`status IN ('completed', 'failed') AND created_at < ${utcWallTime(cutoffIso)} AND expires_at < ${utcWallTime(nowIso)}`,
);

const target = (overrides: Partial<RetentionTarget> = {}): RetentionTarget => ({
  metricName: 'webhook_delivery_retention',
  table: 'webhook_deliveries',
  action: { kind: 'delete' },
  where: whereSpy,
  ...overrides,
});

const knobs = (overrides: Partial<RetentionKnobs> = {}): RetentionKnobs => ({
  retentionDays: 30,
  batchSize: 100,
  maxBatches: 5,
  enforce: false,
  ...overrides,
});

const opts = { logPrefix: '[TestRetention]', label: 'testRetention', enforceVar: 'TEST_RETENTION_ENFORCE', now: NOW };

describe('runRetentionTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.countEligibleRows.mockResolvedValue({ eligible: 7, capped: false });
    m.pruneInCtidBatches.mockResolvedValue({ deleted: 40, batches: 1, hasMore: false });
    m.updateInCtidBatches.mockResolvedValue({ deleted: 12, batches: 1, hasMore: false });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('report mode counts once, bounded by one enforce run, and never writes', async () => {
    const result = await runRetentionTarget(target(), knobs({ batchSize: 100, maxBatches: 5 }), opts);

    expect(m.countEligibleRows).toHaveBeenCalledTimes(1);
    expect(m.countEligibleRows.mock.calls[0]?.[0]).toMatchObject({
      table: 'webhook_deliveries',
      cap: 500,
      label: 'testRetention',
    });
    expect(m.pruneInCtidBatches).not.toHaveBeenCalled();
    expect(m.updateInCtidBatches).not.toHaveBeenCalled();
    expect(m.warnOnRetentionBacklog).not.toHaveBeenCalled();

    expect(m.recordRetentionRun).toHaveBeenCalledTimes(1);
    expect(m.recordRetentionRun.mock.calls[0]?.[0]).toBe('webhook_delivery_retention');
    // Exactly — a rowsDeleted: 0 would claim a measured delete; incomplete
    // would publish a backlog signal for a run that did not try to delete.
    expect(m.recordRetentionRun.mock.calls[0]?.[1]).toEqual({ rowsEligible: 7 });

    expect(result).toMatchObject({
      mode: 'report',
      table: 'webhook_deliveries',
      retentionDays: 30,
      eligible: 7,
      eligibleCapped: false,
    });
  });

  it('report mode logs REPORT-ONLY with the count, the window and the variable that enables deletion', async () => {
    m.countEligibleRows.mockResolvedValueOnce({ eligible: 500, capped: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runRetentionTarget(target(), knobs(), opts);

    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('REPORT-ONLY'));
    expect(line).toBeDefined();
    expect(line).toContain('[TestRetention]');
    expect(line).toContain('500+ webhook_deliveries rows eligible');
    expect(line).toContain('window 30 d');
    expect(line).toContain('TEST_RETENTION_ENFORCE');
    expect(result).toMatchObject({ mode: 'report', eligible: 500, eligibleCapped: true });
  });

  // Review Focus 1. If the count and the delete used different SQL, Gate G1
  // would approve something other than what runs.
  it('report and enforce render the identical predicate, sql and params', async () => {
    await runRetentionTarget(target(), knobs({ enforce: false }), opts);
    await runRetentionTarget(target(), knobs({ enforce: true }), opts);

    const countWhere = render(m.countEligibleRows.mock.calls[0]?.[0].where);
    const pruneWhere = render(m.pruneInCtidBatches.mock.calls[0]?.[0].where);
    expect(countWhere).toEqual(pruneWhere);
    expect(countWhere.sql).toContain("AT TIME ZONE 'UTC'");
  });

  it('calls the predicate builder exactly once per run, with the cutoff and the run instant', async () => {
    await runRetentionTarget(target(), knobs({ retentionDays: 30 }), opts);

    expect(whereSpy).toHaveBeenCalledTimes(1);
    const [cutoffIso, nowIso] = whereSpy.mock.calls[0]!;
    expect(nowIso).toBe(NOW.toISOString());
    expect(cutoffIso).toBe(new Date(NOW.getTime() - 30 * DAY_MS).toISOString());
    expect(cutoffIso).toBe('2026-10-10T12:34:56.789Z');

    // And what the builder returned is what reached the count, unchanged.
    const { params } = render(m.countEligibleRows.mock.calls[0]?.[0].where);
    expect(params).toEqual(['2026-10-10T12:34:56.789Z', NOW.toISOString()]);
  });

  it('enforce delete routes to pruneInCtidBatches with the knobs and records the delete', async () => {
    const result = await runRetentionTarget(target(), knobs({ enforce: true, batchSize: 250, maxBatches: 9 }), opts);

    expect(m.countEligibleRows).not.toHaveBeenCalled();
    expect(m.updateInCtidBatches).not.toHaveBeenCalled();
    expect(m.pruneInCtidBatches).toHaveBeenCalledTimes(1);
    expect(m.pruneInCtidBatches.mock.calls[0]?.[0]).toMatchObject({
      table: 'webhook_deliveries',
      batchSize: 250,
      maxBatches: 9,
      label: 'testRetention',
    });
    expect(m.warnOnRetentionBacklog).toHaveBeenCalledWith(
      '[TestRetention]',
      'webhook_deliveries',
      { deleted: 40, batches: 1, hasMore: false },
    );
    expect(m.recordRetentionRun).toHaveBeenCalledWith('webhook_delivery_retention', { rowsDeleted: 40, incomplete: false });
    expect(result).toMatchObject({ mode: 'enforce', table: 'webhook_deliveries', affected: 40, batches: 1, hasMore: false });
  });

  it('enforce records a backlog when the batch cap left rows behind', async () => {
    m.pruneInCtidBatches.mockResolvedValueOnce({ deleted: 500, batches: 5, hasMore: true });

    const result = await runRetentionTarget(target(), knobs({ enforce: true }), opts);

    expect(m.warnOnRetentionBacklog).toHaveBeenCalledWith(
      '[TestRetention]',
      'webhook_deliveries',
      { deleted: 500, batches: 5, hasMore: true },
    );
    expect(m.recordRetentionRun).toHaveBeenCalledWith('webhook_delivery_retention', { rowsDeleted: 500, incomplete: true });
    expect(result).toMatchObject({ mode: 'enforce', hasMore: true });
  });

  it('enforce scrub routes to updateInCtidBatches with the target SET clause', async () => {
    const set = sql`stdout = NULL, stderr = NULL`;
    await runRetentionTarget(target({ table: 'script_executions', action: { kind: 'scrub', set } }), knobs({ enforce: true }), opts);

    expect(m.pruneInCtidBatches).not.toHaveBeenCalled();
    expect(m.updateInCtidBatches).toHaveBeenCalledTimes(1);
    const args = m.updateInCtidBatches.mock.calls[0]?.[0];
    expect(args.table).toBe('script_executions');
    expect(args.set).toBe(set);
    expect(m.recordRetentionRun).toHaveBeenCalledWith('webhook_delivery_retention', { rowsDeleted: 12, incomplete: false });
  });

  it('a scrub target in report mode still only counts', async () => {
    await runRetentionTarget(
      target({ table: 'script_executions', action: { kind: 'scrub', set: sql`stdout = NULL` } }),
      knobs({ enforce: false }),
      opts,
    );
    expect(m.countEligibleRows).toHaveBeenCalledTimes(1);
    expect(m.updateInCtidBatches).not.toHaveBeenCalled();
    expect(m.pruneInCtidBatches).not.toHaveBeenCalled();
  });

  it('propagates a failing batch without recording a run', async () => {
    m.pruneInCtidBatches.mockRejectedValueOnce(new Error('statement timeout'));

    await expect(runRetentionTarget(target(), knobs({ enforce: true }), opts)).rejects.toThrow('statement timeout');
    expect(m.pruneInCtidBatches).toHaveBeenCalledTimes(1);
    expect(m.recordRetentionRun).not.toHaveBeenCalled();
  });

  it('refuses an unusable window instead of computing an invalid cutoff, in either mode', async () => {
    for (const enforce of [false, true]) {
      for (const retentionDays of [0, -1, Number.NaN, 1.5]) {
        await expect(runRetentionTarget(target(), knobs({ retentionDays, enforce }), opts)).rejects.toThrow(/retentionDays/);
      }
    }
    // A window of 0 under enforce would make every row eligible.
    expect(m.countEligibleRows).not.toHaveBeenCalled();
    expect(m.pruneInCtidBatches).not.toHaveBeenCalled();
    expect(m.updateInCtidBatches).not.toHaveBeenCalled();
  });

  // Report evidence must not be produced from knobs that enforce would reject.
  it('rejects non-integer batch knobs in report mode too', async () => {
    await expect(runRetentionTarget(target(), knobs({ batchSize: 2.5 }), opts)).rejects.toThrow(/batchSize/);
    await expect(runRetentionTarget(target(), knobs({ maxBatches: 0 }), opts)).rejects.toThrow(/maxBatches/);
    expect(m.countEligibleRows).not.toHaveBeenCalled();
  });

  it('a scrub renders the identical predicate in report and enforce', async () => {
    const scrub = target({ table: 'script_executions', action: { kind: 'scrub', set: sql`stdout = NULL` } });
    await runRetentionTarget(scrub, knobs({ enforce: false }), opts);
    await runRetentionTarget(scrub, knobs({ enforce: true }), opts);
    expect(render(m.countEligibleRows.mock.calls[0]?.[0].where)).toEqual(render(m.updateInCtidBatches.mock.calls[0]?.[0].where));
  });
});

describe('runRetentionTargets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.countEligibleRows.mockResolvedValue({ eligible: 3, capped: false });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('isolates a failing target: the rest still run, results stay in input order', async () => {
    m.countEligibleRows
      .mockRejectedValueOnce(new Error('relation does not exist'))
      .mockResolvedValueOnce({ eligible: 3, capped: false });

    const results = await runRetentionTargets(
      [
        { target: target({ table: 't1', metricName: 'audit_retention' }), knobs: knobs() },
        { target: target({ table: 't2', metricName: 'snmp_retention' }), knobs: knobs() },
      ],
      opts,
    );

    expect(m.countEligibleRows).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ table: 't1', error: 'relation does not exist' });
    expect(results[1]).toMatchObject({ mode: 'report', table: 't2', eligible: 3 });
    expect(m.captureException).toHaveBeenCalledTimes(1);
    // Only the bounded literal table name is tagged.
    expect(m.captureException.mock.calls[0]?.[2]).toEqual({ retentionTarget: 't1' });
  });

  // Without a metric, a failed target's backlog gauge keeps its last value
  // (often 0, "fully cleared") and only Sentry — absent on many self-hosted
  // installs — knows anything went wrong.
  it('marks a failed target incomplete on its own metric', async () => {
    m.countEligibleRows.mockRejectedValueOnce(new Error('boom'));

    await runRetentionTargets(
      [
        { target: target({ table: 't1', metricName: 'audit_retention' }), knobs: knobs() },
        { target: target({ table: 't2', metricName: 'snmp_retention' }), knobs: knobs() },
      ],
      opts,
    );

    expect(m.recordRetentionRun).toHaveBeenCalledWith('audit_retention', { incomplete: true });
    expect(m.recordRetentionRun).toHaveBeenCalledWith('snmp_retention', { rowsEligible: 3 });
  });

  // Plan correction 19: the gauges are .set() per job_name, so two targets on
  // one name would overwrite each other's Gate G1 evidence.
  it('refuses two targets sharing a metric name before running any', async () => {
    await expect(runRetentionTargets(
      [
        { target: target({ table: 'a', metricName: 'audit_retention' }), knobs: knobs() },
        { target: target({ table: 'b', metricName: 'audit_retention' }), knobs: knobs() },
      ],
      opts,
    )).rejects.toThrow(/audit_retention/);
    expect(m.countEligibleRows).not.toHaveBeenCalled();
  });

  it('runs targets sequentially, never overlapping', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    m.countEligibleRows.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { eligible: 1, capped: false };
    });

    const names = ['audit_retention', 'snmp_retention', 'flow_run_retention'] as const;
    await runRetentionTargets(
      names.map((metricName, i) => ({ target: target({ table: `t${i}`, metricName }), knobs: knobs() })),
      opts,
    );

    expect(maxInFlight).toBe(1);
  });

  it('gives every target the same run instant', async () => {
    const seen: string[] = [];
    const spy = (cutoffIso: string, nowIso: string) => {
      seen.push(nowIso);
      return sql`created_at < ${cutoffIso}`;
    };

    await runRetentionTargets(
      [
        { target: target({ table: 'a', where: spy, metricName: 'audit_retention' }), knobs: knobs() },
        { target: target({ table: 'b', where: spy, metricName: 'snmp_retention' }), knobs: knobs() },
      ],
      { logPrefix: '[T]', label: 't' },
    );

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });
});
