import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

type ContextTraceEvent =
  | { type: 'escape' }
  | { type: 'open'; label: string | undefined }
  | { type: 'execute' }
  | { type: 'close'; label: string | undefined };

const {
  executeMock,
  shouldProduceMlOutputMock,
  runOutsideDbContextMock,
  withSystemDbAccessContextMock,
  contextTrace,
  openContext,
} = vi.hoisted(() => {
  const contextTrace: ContextTraceEvent[] = [];
  const openContext: { label: string | undefined } = { label: undefined };
  return {
    contextTrace,
    openContext,
    executeMock: vi.fn(),
    shouldProduceMlOutputMock: vi.fn(),
    runOutsideDbContextMock: vi.fn(<T>(fn: () => T): T => {
      contextTrace.push({ type: 'escape' });
      return fn();
    }),
    withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>, label?: string) => {
      contextTrace.push({ type: 'open', label });
      const previous = openContext.label;
      openContext.label = label;
      try {
        return await fn();
      } finally {
        openContext.label = previous;
        contextTrace.push({ type: 'close', label });
      }
    }),
  };
});

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

import { rollupDeviceMetricsRange } from './metricRollups';

/** Contexts opened, in order, from the recorded trace. */
function openedLabels(): Array<string | undefined> {
  return contextTrace.filter((event) => event.type === 'open').map((event) => event.label);
}

/** Every statement issued under `label`: its serialization and the SQL object itself. */
const executedByLabel = new Map<string, Array<{ json: string; statement: SQL }>>();

/**
 * The one statement issued under `label`. Fails loudly when a label ran more
 * (or fewer) than once, which is exactly the #4341 regression: one statement
 * per raw source table, not one per metric.
 */
function onlyStatementFor(label: string): string {
  const statements = executedByLabel.get(label) ?? [];
  expect(statements).toHaveLength(1);
  return (statements[0] as { json: string }).json;
}

/**
 * The bound parameters of the one statement issued under `label`, in order.
 * Substring assertions on the serialized SQL cannot tell `'cpu'` the metric_type
 * from `'cpu_percent'` the metric_name, so anything about which value is bound
 * WHERE has to read the compiled parameter list instead.
 */
function onlyStatementParamsFor(label: string): unknown[] {
  const statements = executedByLabel.get(label) ?? [];
  expect(statements).toHaveLength(1);
  return new PgDialect().sqlToQuery((statements[0] as { statement: SQL }).statement).params;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('metric rollups service', () => {
  beforeEach(() => {
    contextTrace.length = 0;
    executedByLabel.clear();
    openContext.label = undefined;
    executeMock.mockReset();
    executeMock.mockImplementation(async (statement: unknown) => {
      contextTrace.push({ type: 'execute' });
      const label = openContext.label ?? '<no-context>';
      const existing = executedByLabel.get(label) ?? [];
      existing.push({ json: JSON.stringify(statement), statement: statement as SQL });
      executedByLabel.set(label, existing);
      return [];
    });
    shouldProduceMlOutputMock.mockReset();
    shouldProduceMlOutputMock.mockResolvedValue(true);
    runOutsideDbContextMock.mockClear();
    withSystemDbAccessContextMock.mockClear();
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

    expect(result).toMatchObject({ statements: 9, skipped: false });
    expect(executeMock).toHaveBeenCalledTimes(9);
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

    const rawStatementSql = onlyStatementFor('metricRollups.raw.device_metrics');
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

    // The raw device statement's LEFT JOIN must carry an explicit [from,to)
    // bound in addition to the per-bucket bound; without it the
    // generate_series-derived bucket_start predicate is non-sargable and
    // Postgres bitmap-scans each device's entire history.
    const rawDeviceSql = onlyStatementFor('metricRollups.raw.device_metrics');
    expect(rawDeviceSql).toContain('LEFT JOIN device_metrics');
    expect(rawDeviceSql).toContain('join window bound');
  });

  it('lets derived rollups include gap buckets without averaging empty values', async () => {
    await rollupDeviceMetricsRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T13:00:00.000Z'),
    });

    const hourlyStatementSql = onlyStatementFor('metricRollups.derived.device_metrics.3600');
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

    // All seven series now come out of ONE statement (#4341); each assertion
    // below still pins the SQL that produces its series.
    const processStatementSql = onlyStatementFor('metricRollups.raw.device_process_samples');
    expect(processStatementSql).toContain('device_process_samples');
    expect(processStatementSql).toContain('process_devices');
    expect(processStatementSql).toContain('sample_values');
    expect(processStatementSql).toContain('top_process_count');
    expect(processStatementSql).toContain('jsonb_array_length(dps.top_processes)');
    expect(processStatementSql).toContain("'process'");

    expect(processStatementSql).toContain('top_process_cpu_percent_sum');
    expect(processStatementSql).toContain('jsonb_array_elements(dps.top_processes)');
    expect(processStatementSql).toContain("proc.value -> 'cpu'");

    expect(processStatementSql).toContain('top_process_cpu_percent_max');
    expect(processStatementSql).toContain('max(');

    expect(processStatementSql).toContain('top_process_ram_mb_max');
    expect(processStatementSql).toContain("proc.value -> 'ramMb'");

    const processHourlyStatementSql = onlyStatementFor('metricRollups.derived.device_process_samples.3600');
    expect(processHourlyStatementSql).toContain('device_process_samples');
    expect(processHourlyStatementSql).toContain('sourceBucketSeconds');
  });

  it('rolls up numeric SNMP metrics for SNMP assets linked to managed devices', async () => {
    await rollupDeviceMetricsRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:15:00.000Z'),
    });

    const snmpStatementSql = onlyStatementFor('metricRollups.raw.snmp_metrics');
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

    const snmpHourlyStatementSql = onlyStatementFor('metricRollups.derived.snmp_metrics.3600');
    expect(snmpHourlyStatementSql).toContain('snmp_metrics');
    expect(snmpHourlyStatementSql).toContain('sourceBucketSeconds');
  });

  // #4341 — the raw passes used to issue ONE full CTE per metric: 10 scans of
  // the `device_metrics` window plus 7 scans of the `device_process_samples`
  // window, per org, every 5 minutes. On US prod the process-sample CTE alone
  // ran ~107k times over 31.5h at 1.5-2.0s mean (~168,600s total, ~150% of the
  // managed DB's single vCPU, 900+GB of shared buffer reads) and was the top DB
  // load by a wide margin. Each source window is now scanned once and every
  // series is derived from that single pass.
  describe('#4341 single-pass raw rollups', () => {
    const DEVICE_METRIC_SERIES: ReadonlyArray<readonly [string, string]> = [
      ['cpu', 'cpu_percent'],
      ['memory', 'ram_percent'],
      ['memory', 'ram_used_mb'],
      ['disk', 'disk_percent'],
      ['disk', 'disk_used_gb'],
      ['disk', 'disk_read_bps'],
      ['disk', 'disk_write_bps'],
      ['network', 'bandwidth_in_bps'],
      ['network', 'bandwidth_out_bps'],
      ['process', 'process_count'],
    ];
    const PROCESS_METRIC_SERIES: readonly string[] = [
      'top_process_count',
      'top_process_cpu_percent_sum',
      'top_process_cpu_percent_max',
      'top_process_ram_mb_sum',
      'top_process_ram_mb_max',
      'top_process_disk_bps_sum',
      'top_process_net_bps_sum',
    ];

    const RANGE = {
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T13:00:00.000Z'),
    } as const;

    it('scans each raw source window once per pass, not once per metric', async () => {
      const result = await rollupDeviceMetricsRange({ ...RANGE });

      // 1 device_metrics + 1 device_process_samples + 1 snmp_metrics + 6 derived.
      expect(result).toMatchObject({ statements: 9, skipped: false });
      expect(executeMock).toHaveBeenCalledTimes(9);
      expect(executedByLabel.get('metricRollups.raw.device_metrics')).toHaveLength(1);
      expect(executedByLabel.get('metricRollups.raw.device_process_samples')).toHaveLength(1);
    });

    it('derives all ten device_metrics series from that one scan, each keeping its own metric_type', async () => {
      await rollupDeviceMetricsRange({ ...RANGE });

      const deviceSql = onlyStatementFor('metricRollups.raw.device_metrics');
      for (const [, metricName] of DEVICE_METRIC_SERIES) {
        expect(deviceSql).toContain(metricName);
      }

      // `toContain(metricType)` would be vacuous here — 'cpu' is a substring of
      // 'cpu_percent', 'disk' of 'disk_percent', 'process' of 'process_count' —
      // so it would still pass with metric_type dropped from the unpivot
      // entirely. The unpivot binds each row as (metric_type, metric_name), so
      // assert on that adjacency in the compiled parameter list instead. Each
      // name is bound twice (the non-null probe, then the unpivot); the unpivot
      // is the later one.
      const params = onlyStatementParamsFor('metricRollups.raw.device_metrics');
      for (const [metricType, metricName] of DEVICE_METRIC_SERIES) {
        const unpivotIndex = params.lastIndexOf(metricName);
        expect(unpivotIndex).toBeGreaterThan(0);
        expect(params[unpivotIndex - 1]).toBe(metricType);
      }
      // The window itself is read at most twice (device discovery + the bucket
      // join). Ten reads is the bug.
      expect(countOccurrences(deviceSql, 'FROM device_metrics')).toBeLessThanOrEqual(2);
    });

    it('keeps the per-metric non-null device filter so nullable columns gain no phantom gap rows', async () => {
      await rollupDeviceMetricsRange({ ...RANGE });

      // Half the device_metrics columns are nullable (disk_*_bps, bandwidth_*_bps,
      // process_count). Per-metric statements each built their own device list
      // with `WHERE <col> IS NOT NULL`, so a device that never reported
      // process_count produced NO process_count rollups. A shared bucket grid
      // must not silently start emitting `isGap` rows for those series.
      const deviceSql = onlyStatementFor('metricRollups.raw.device_metrics');
      expect(deviceSql).toContain('metric_devices');
      expect(deviceSql).toContain('IS NOT NULL');
      for (const [, metricName] of DEVICE_METRIC_SERIES) {
        expect(deviceSql).toContain(`dm.${metricName} IS NOT NULL`);
      }
    });

    it('derives all seven process-sample series from that one scan', async () => {
      await rollupDeviceMetricsRange({ ...RANGE });

      const processSql = onlyStatementFor('metricRollups.raw.device_process_samples');
      for (const metricName of PROCESS_METRIC_SERIES) {
        expect(processSql).toContain(metricName);
      }
      expect(countOccurrences(processSql, 'FROM device_process_samples')).toBe(2);
    });

    it('expands each top_processes array once per sample row, not once per metric', async () => {
      await rollupDeviceMetricsRange({ ...RANGE });

      // Six of the seven process series aggregate the SAME jsonb array. Running
      // `jsonb_array_elements` once per series re-parses every sample six times;
      // that jsonb work, not just the table scan, is what made this CTE the top
      // DB consumer.
      const processSql = onlyStatementFor('metricRollups.raw.device_process_samples');
      expect(countOccurrences(processSql, 'jsonb_array_elements(dps.top_processes)')).toBe(1);
    });
  });

  // #4276 — metricRollupsWorker was the top `db_context_held_too_long` offender
  // (983 events/7d) because all of the pass's statements ran inside ONE
  // withSystemDbAccessContext, pinning a single pooled connection for 2s+ every
  // 5 minutes. Every statement here is an idempotent upsert, so the atomic
  // transaction bought nothing: each one now gets its own short-lived context.
  describe('#4276 per-statement DB contexts', () => {
    it('opens one short-lived system context per statement, never one spanning all of them', async () => {
      await rollupDeviceMetricsRange({
        orgId: '11111111-1111-1111-1111-111111111111',
        from: new Date('2026-06-18T12:00:00.000Z'),
        to: new Date('2026-06-18T13:00:00.000Z'),
      });

      // 9 upserts + the ML feature-flag gate read = 10 contexts, each closing
      // before the next opens. A trace with two consecutive `open`s means a
      // context spans more than one statement, which is the bug.
      expect(openedLabels()).toHaveLength(10);
      expect(executeMock).toHaveBeenCalledTimes(9);

      let depth = 0;
      let maxDepth = 0;
      let executesInsideAContext = 0;
      for (const event of contextTrace) {
        if (event.type === 'open') {
          depth += 1;
          maxDepth = Math.max(maxDepth, depth);
        } else if (event.type === 'close') {
          depth -= 1;
        } else if (event.type === 'execute' && depth > 0) {
          executesInsideAContext += 1;
        }
      }
      expect(maxDepth).toBe(1);
      expect(executesInsideAContext).toBe(9);
    });

    it('escapes any ambient DB context so a wrapping caller cannot re-create the single long hold', async () => {
      await rollupDeviceMetricsRange({
        orgId: '11111111-1111-1111-1111-111111111111',
        from: new Date('2026-06-18T12:00:00.000Z'),
        to: new Date('2026-06-18T13:00:00.000Z'),
      });

      // runOutsideDbContext must precede every context; without it a caller that
      // already holds a context makes withDbAccessContext short-circuit and all
      // 9 statements silently rejoin the outer transaction again (the
      // alertWorker/#3216 trap).
      expect(runOutsideDbContextMock).toHaveBeenCalledTimes(10);
      const escapeThenOpen = contextTrace
        .filter((event) => event.type === 'escape' || event.type === 'open')
        .map((event) => event.type);
      expect(escapeThenOpen).toEqual(
        Array.from({ length: 10 }, () => ['escape', 'open'] as const).flat(),
      );
    });

    it('labels every context so Sentry attribution survives the tsup bundle', async () => {
      await rollupDeviceMetricsRange({
        orgId: '11111111-1111-1111-1111-111111111111',
        from: new Date('2026-06-18T12:00:00.000Z'),
        to: new Date('2026-06-18T13:00:00.000Z'),
      });

      // `parseOpenerFrame` collapses every anonymous-arrow opener in the bundled
      // API to a bare `index`, so an unlabelled context is unattributable in
      // Sentry. Labels stay low-cardinality (one per rollup pass) because they
      // become the `dbContextLabel` tag AND part of the grouped message.
      expect(openedLabels().every((label) => typeof label === 'string' && label.length > 0)).toBe(true);
      expect(new Set(openedLabels())).toEqual(new Set([
        'metricRollups.mlFeatureGate',
        'metricRollups.raw.device_metrics',
        'metricRollups.raw.device_process_samples',
        'metricRollups.raw.snmp_metrics',
        'metricRollups.derived.device_metrics.3600',
        'metricRollups.derived.device_metrics.86400',
        'metricRollups.derived.device_process_samples.3600',
        'metricRollups.derived.device_process_samples.86400',
        'metricRollups.derived.snmp_metrics.3600',
        'metricRollups.derived.snmp_metrics.86400',
      ]));
    });

    it('gates the ML feature-flag read behind its own context so it never runs on the bare pool', async () => {
      shouldProduceMlOutputMock.mockResolvedValue(false);

      await rollupDeviceMetricsRange({
        orgId: '11111111-1111-1111-1111-111111111111',
        from: new Date('2026-06-18T12:00:00.000Z'),
        to: new Date('2026-06-18T12:15:00.000Z'),
      });

      // The gate reads `organizations` + `partners`, both RLS-forced: with no
      // context the read silently returns zero rows and every org looks disabled.
      expect(openedLabels()).toEqual(['metricRollups.mlFeatureGate']);
      expect(shouldProduceMlOutputMock).toHaveBeenCalledTimes(1);
    });

    // The split from one atomic transaction to per-statement commits is only
    // safe because (a) a mid-pass throw PROPAGATES — a partial pass must fail
    // the BullMQ job / backfill, never be reported as success — and (b) the
    // already-committed statements stay committed and are re-covered by the
    // next run's idempotent upserts. This pins (a) and the stop-at-failure
    // shape; the committed-stays-committed half lives in the integration
    // suite where real transactions exist.
    it('propagates a mid-pass statement failure and stops — no later statements, no success result', async () => {
      const boom = new Error('relation "metric_rollups" deadlocked');
      executeMock.mockImplementation(async () => {
        contextTrace.push({ type: 'execute' });
        if (executeMock.mock.calls.length === 5) throw boom;
        return [];
      });

      await expect(
        rollupDeviceMetricsRange({
          orgId: '11111111-1111-1111-1111-111111111111',
          from: new Date('2026-06-18T12:00:00.000Z'),
          to: new Date('2026-06-18T13:00:00.000Z'),
        }),
      ).rejects.toThrow(boom);

      // Statements 1-4 ran (and, in production, committed); statement 5 threw;
      // 6-9 never ran. Plus the ML gate context, that is exactly 6 opens —
      // and every context still closed, so the failure cannot leak a held
      // connection either.
      expect(executeMock).toHaveBeenCalledTimes(5);
      expect(openedLabels()).toHaveLength(6);
      expect(contextTrace.filter((event) => event.type === 'close')).toHaveLength(6);
    });
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
