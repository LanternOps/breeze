import { beforeEach, describe, expect, it, vi } from 'vitest';

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
} = vi.hoisted(() => {
  const contextTrace: ContextTraceEvent[] = [];
  return {
    contextTrace,
    executeMock: vi.fn(),
    shouldProduceMlOutputMock: vi.fn(),
    runOutsideDbContextMock: vi.fn(<T>(fn: () => T): T => {
      contextTrace.push({ type: 'escape' });
      return fn();
    }),
    withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>, label?: string) => {
      contextTrace.push({ type: 'open', label });
      try {
        return await fn();
      } finally {
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

describe('metric rollups service', () => {
  beforeEach(() => {
    contextTrace.length = 0;
    executeMock.mockReset();
    executeMock.mockImplementation(async () => {
      contextTrace.push({ type: 'execute' });
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

  // #4276 — metricRollupsWorker was the top `db_context_held_too_long` offender
  // (983 events/7d) because all 26 statements ran inside ONE
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

      // 24 upserts + the ML feature-flag gate read = 25 contexts, each closing
      // before the next opens. A trace with two consecutive `open`s means a
      // context spans more than one statement, which is the bug.
      expect(openedLabels()).toHaveLength(25);
      expect(executeMock).toHaveBeenCalledTimes(24);

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
      expect(executesInsideAContext).toBe(24);
    });

    it('escapes any ambient DB context so a wrapping caller cannot re-create the single long hold', async () => {
      await rollupDeviceMetricsRange({
        orgId: '11111111-1111-1111-1111-111111111111',
        from: new Date('2026-06-18T12:00:00.000Z'),
        to: new Date('2026-06-18T13:00:00.000Z'),
      });

      // runOutsideDbContext must precede every context; without it a caller that
      // already holds a context makes withDbAccessContext short-circuit and all
      // 24 statements silently rejoin the outer transaction again (the
      // alertWorker/#3216 trap).
      expect(runOutsideDbContextMock).toHaveBeenCalledTimes(25);
      const escapeThenOpen = contextTrace
        .filter((event) => event.type === 'escape' || event.type === 'open')
        .map((event) => event.type);
      expect(escapeThenOpen).toEqual(
        Array.from({ length: 25 }, () => ['escape', 'open'] as const).flat(),
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
      // 6-24 never ran. Plus the ML gate context, that is exactly 6 opens —
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
