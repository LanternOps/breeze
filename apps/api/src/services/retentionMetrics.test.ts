import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Registry } from 'prom-client';

import {
  RETENTION_JOB_NAMES,
  recordRetentionRun,
  recordRollupRun,
  registerRetentionPrometheusMetrics,
  setRetentionMetricsRecorder,
} from './retentionMetrics';

type Sample = { labels: Record<string, string>; value: number; metricName?: string };

async function samplesFor(registry: Registry, metricName: string): Promise<Sample[]> {
  const metric = registry.getSingleMetric(metricName);
  if (!metric) return [];
  const collected = (await metric.get()) as { values: Sample[] };
  return collected.values;
}

function valueFor(samples: Sample[], labels: Record<string, string>): number | undefined {
  const match = samples.find((sample) =>
    Object.entries(labels).every(([key, value]) => sample.labels[key] === value)
  );
  return match?.value;
}

/** prom-client emits histogram aggregates as `<name>_sum` / `<name>_count` rows. */
function histogramAggregate(
  samples: Sample[],
  suffix: '_sum' | '_count',
  labels: Record<string, string>
): number | undefined {
  const match = samples.find(
    (sample) =>
      sample.metricName?.endsWith(suffix) &&
      Object.entries(labels).every(([key, value]) => sample.labels[key] === value)
  );
  return match?.value;
}

describe('retention/rollup job metrics', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
    registerRetentionPrometheusMetrics(registry);
  });

  afterEach(() => {
    setRetentionMetricsRecorder(null);
    vi.useRealTimers();
  });

  it('registers the five series named in the issue on the supplied registry', () => {
    for (const name of [
      'breeze_retention_rows_deleted_total',
      'breeze_retention_last_run_timestamp_seconds',
      'breeze_retention_backlog_incomplete',
      'breeze_rollup_runs_total',
      'breeze_rollup_duration_seconds',
    ]) {
      expect(registry.getSingleMetric(name), `${name} should be registered`).toBeDefined();
    }
  });

  it('publishes no retention series until a job actually runs', async () => {
    // Deliberately unseeded: retention workers run on ONE instance (global /
    // socket-owner placement), so seeding every replica would publish a
    // permanent "never ran" series on replicas that never run the job.
    expect(await samplesFor(registry, 'breeze_retention_rows_deleted_total')).toHaveLength(0);
    expect(await samplesFor(registry, 'breeze_retention_last_run_timestamp_seconds')).toHaveLength(0);
    expect(await samplesFor(registry, 'breeze_retention_backlog_incomplete')).toHaveLength(0);
  });

  it('increments the rows-deleted counter and stamps last-run for the given job', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'));

    recordRetentionRun('device_metrics_retention', { rowsDeleted: 42 });
    recordRetentionRun('device_metrics_retention', { rowsDeleted: 8 });

    const deleted = await samplesFor(registry, 'breeze_retention_rows_deleted_total');
    expect(valueFor(deleted, { job_name: 'device_metrics_retention' })).toBe(50);

    const lastRun = await samplesFor(registry, 'breeze_retention_last_run_timestamp_seconds');
    expect(valueFor(lastRun, { job_name: 'device_metrics_retention' })).toBe(
      Date.parse('2026-08-31T12:00:00.000Z') / 1000
    );
  });

  it('keeps per-job counters isolated by the job_name label', async () => {
    recordRetentionRun('audit_retention', { rowsDeleted: 5 });
    recordRetentionRun('snmp_retention');

    const deleted = await samplesFor(registry, 'breeze_retention_rows_deleted_total');
    expect(valueFor(deleted, { job_name: 'audit_retention' })).toBe(5);
    // A job that reports no rows-deleted must NOT publish a rows-deleted series
    // — a permanent 0 there reads as "deleted nothing", not "not measured".
    expect(valueFor(deleted, { job_name: 'snmp_retention' })).toBeUndefined();

    const lastRun = await samplesFor(registry, 'breeze_retention_last_run_timestamp_seconds');
    expect(valueFor(lastRun, { job_name: 'snmp_retention' })).toBeGreaterThan(0);
  });

  it('sets the backlog gauge to 1 when a capped run did not finish, 0 when it did', async () => {
    recordRetentionRun('ml_output_retention', { rowsDeleted: 100, incomplete: true });
    recordRetentionRun('user_risk_retention', { rowsDeleted: 3, incomplete: false });

    const backlog = await samplesFor(registry, 'breeze_retention_backlog_incomplete');
    expect(valueFor(backlog, { job_name: 'ml_output_retention' })).toBe(1);
    expect(valueFor(backlog, { job_name: 'user_risk_retention' })).toBe(0);
  });

  it('omits the backlog gauge for jobs that report no completeness signal', async () => {
    recordRetentionRun('agent_log_retention', { rowsDeleted: 1 });

    const backlog = await samplesFor(registry, 'breeze_retention_backlog_incomplete');
    expect(valueFor(backlog, { job_name: 'agent_log_retention' })).toBeUndefined();
  });

  it('clamps a negative or non-finite rows-deleted count to zero', async () => {
    recordRetentionRun('change_log_retention', { rowsDeleted: -7 });
    recordRetentionRun('change_log_retention', { rowsDeleted: Number.NaN });

    const deleted = await samplesFor(registry, 'breeze_retention_rows_deleted_total');
    expect(valueFor(deleted, { job_name: 'change_log_retention' })).toBe(0);
  });

  it('records rollup runs by status with their duration', async () => {
    recordRollupRun('success', 1.5);
    recordRollupRun('success', 0.5);
    recordRollupRun('failure', 2);

    const runs = await samplesFor(registry, 'breeze_rollup_runs_total');
    expect(valueFor(runs, { status: 'success' })).toBe(2);
    expect(valueFor(runs, { status: 'failure' })).toBe(1);

    const duration = await samplesFor(registry, 'breeze_rollup_duration_seconds');
    expect(histogramAggregate(duration, '_count', { status: 'success' })).toBe(2);
    expect(histogramAggregate(duration, '_sum', { status: 'success' })).toBe(2);
    expect(histogramAggregate(duration, '_sum', { status: 'failure' })).toBe(2);
  });

  it('clamps a negative rollup duration to zero', async () => {
    recordRollupRun('skipped', -1);

    const duration = await samplesFor(registry, 'breeze_rollup_duration_seconds');
    expect(histogramAggregate(duration, '_sum', { status: 'skipped' })).toBe(0);
    expect(histogramAggregate(duration, '_count', { status: 'skipped' })).toBe(1);
  });

  it('swallows a throwing recorder instead of failing the job that called it', () => {
    // Every retention call site sits immediately before the job's `return`,
    // AFTER the DELETE committed — a throw here would turn a successful purge
    // into a failed BullMQ job.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('prom-client: Invalid number of arguments');
    setRetentionMetricsRecorder({
      onRetentionRun: () => {
        throw boom;
      },
      onRollupRun: () => {
        throw boom;
      },
    });

    expect(() => recordRetentionRun('audit_retention', { rowsDeleted: 1 })).not.toThrow();
    expect(() => recordRollupRun('success', 1)).not.toThrow();
    expect(consoleError).toHaveBeenCalledTimes(2);

    consoleError.mockRestore();
  });

  it('lets a caller rethrow its own error unmasked when the recorder throws in a catch block', () => {
    // `rollupDeviceMetricsRange` calls recordRollupRun('failure', …) from inside
    // a catch. If that call threw, it would REPLACE the in-flight rollup error
    // before the rethrow ran, discarding the actual cause.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    setRetentionMetricsRecorder({
      onRollupRun: () => {
        throw new Error('metrics exploded');
      },
    });

    const original = new Error('rollup statement failed');
    const rethrown = (() => {
      try {
        throw original;
      } catch (error) {
        recordRollupRun('failure', 0.5);
        return error;
      }
    })();

    expect(rethrown).toBe(original);
    consoleError.mockRestore();
  });

  it('flags a run that errored past items as incomplete, not as a clean sweep', async () => {
    // audit_retention swallows per-policy failures and continues; the degenerate
    // "every policy failed" run must not look healthy on the dashboard.
    recordRetentionRun('audit_retention', { rowsDeleted: 0, incomplete: true });

    const backlog = await samplesFor(registry, 'breeze_retention_backlog_incomplete');
    expect(valueFor(backlog, { job_name: 'audit_retention' })).toBe(1);

    const lastRun = await samplesFor(registry, 'breeze_retention_last_run_timestamp_seconds');
    expect(valueFor(lastRun, { job_name: 'audit_retention' })).toBeGreaterThan(0);
  });

  it('is an inert no-op before any registry has been wired up', () => {
    setRetentionMetricsRecorder(null);
    expect(() => recordRetentionRun('playbook_retention', { rowsDeleted: 1 })).not.toThrow();
    expect(() => recordRollupRun('success', 1)).not.toThrow();
  });

  it('exposes every instrumented job name exactly once, in sorted order', () => {
    expect(new Set(RETENTION_JOB_NAMES).size).toBe(RETENTION_JOB_NAMES.length);
    expect([...RETENTION_JOB_NAMES]).toEqual([...RETENTION_JOB_NAMES].sort());
  });
});
