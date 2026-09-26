/**
 * Topology operational metrics (M3 Task 11): telemetry ingest, poll lag,
 * diagnostic dispatch/results, the orphan sweeper, the recurring scheduler,
 * health assessment and history reads.
 *
 * A LEAF module — `prom-client` plus `../metricsRegistry`, nothing else — for
 * the same reason as metricAnomalyEpisodeMetrics.ts: the scheduler, sweeper
 * and assessment drain run in the WORKER role, which never loads
 * routes/metrics.ts, so registering here is what makes the series appear in the
 * process that produces them.
 *
 * Cardinality contract (plan Task 11): labels are only recipe / status /
 * platform / resolution, and every label value is checked against a closed
 * allowlist — anything else collapses to `other`. A site/org/device id, a node
 * label or an IP address can never become a series.
 */
import { Counter, Histogram } from 'prom-client';

import { metricsRegistry } from '../metricsRegistry';

export const TOPOLOGY_METRIC_NAMES = {
  telemetryBatches: 'topology_interface_telemetry_batches_total',
  telemetrySamples: 'topology_interface_telemetry_samples_total',
  telemetryBatchBytes: 'topology_interface_telemetry_batch_bytes',
  telemetryLag: 'topology_interface_telemetry_lag_seconds',
  telemetrySourceSwitches: 'topology_interface_telemetry_source_switches_total',
  dispatchDuration: 'topology_diagnostic_dispatch_duration_seconds',
  diagnosticResults: 'topology_diagnostic_results_total',
  diagnosticRunsExpired: 'topology_diagnostic_runs_expired_total',
  schedulerOccurrences: 'topology_monitoring_occurrences_total',
  assessments: 'topology_monitoring_assessments_total',
  historyBuckets: 'topology_interface_history_buckets',
} as const;

const RECIPES = ['gateway_basic', 'dns_basic', 'internet_basic', 'target_connectivity', 'trace_route'] as const;
const TELEMETRY_BATCH_STATUSES = [
  'accepted', 'refused', 'batch_in_flight', 'invalid_capture_time', 'interface_not_authorized', 'interface_not_found',
  'interface_epoch_mismatch', 'source_revoked', 'stale_sequence', 'sequence_conflict', 'sample_conflict',
  'telemetry_quota_exceeded', 'partition_unavailable',
] as const;
const DISPATCH_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'expired', 'rejected', 'error'] as const;
const RESULT_STATUSES = ['accepted', 'rejected', 'late', 'duplicate'] as const;
const SCHEDULER_STATUSES = ['dispatched', 'quota_gap', 'skipped', 'disarmed'] as const;
const ASSESSMENT_STATUSES = ['applied', 'alert_opened', 'alert_recovered'] as const;
const RESOLUTIONS = ['raw', '5m', '1h'] as const;

export type TopologyMetricRecipe = typeof RECIPES[number];
export type TopologyTelemetryBatchStatus = typeof TELEMETRY_BATCH_STATUSES[number];
export type TopologyDispatchStatus = typeof DISPATCH_STATUSES[number];
export type TopologyResultStatus = typeof RESULT_STATUSES[number];
export type TopologySchedulerStatus = typeof SCHEDULER_STATUSES[number];
export type TopologyAssessmentStatus = typeof ASSESSMENT_STATUSES[number];
export type TopologyHistoryResolution = typeof RESOLUTIONS[number];

function bounded<T extends string>(allowed: readonly T[], value: string): T | 'other' {
  return (allowed as readonly string[]).includes(value) ? value as T : 'other';
}

const positiveCount = (value: number) => Number.isFinite(value) && value > 0;

const telemetryBatches = new Counter({
  name: TOPOLOGY_METRIC_NAMES.telemetryBatches,
  help: 'Interface telemetry (if_metrics) batches by admission outcome; any status other than accepted is a refused batch',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

const telemetrySamples = new Counter({
  name: TOPOLOGY_METRIC_NAMES.telemetrySamples,
  help: 'Interface telemetry samples from accepted batches: inserted (new raw rows), duplicate (identical replays), historical_only (late or retired-generation rows)',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

const telemetryBatchBytes = new Histogram({
  name: TOPOLOGY_METRIC_NAMES.telemetryBatchBytes,
  help: 'Serialized size of accepted interface telemetry batches',
  buckets: [1024, 4096, 16384, 65536, 262144, 1048576],
  registers: [metricsRegistry],
});

const telemetryLag = new Histogram({
  name: TOPOLOGY_METRIC_NAMES.telemetryLag,
  help: 'Seconds from a telemetry batch finishing on the collector to the server accepting it (poll lag)',
  buckets: [1, 5, 15, 30, 60, 120, 300, 900, 3600],
  registers: [metricsRegistry],
});

const telemetrySourceSwitches = new Counter({
  name: TOPOLOGY_METRIC_NAMES.telemetrySourceSwitches,
  help: 'Telemetry sources whose producer epoch changed (collector/controller switch or re-arm), resetting their sequence',
  registers: [metricsRegistry],
});

const dispatchDuration = new Histogram({
  name: TOPOLOGY_METRIC_NAMES.dispatchDuration,
  help: 'Seconds to plan, authorize and queue a topology diagnostic run, by recipe and resulting state',
  labelNames: ['recipe', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

const diagnosticResults = new Counter({
  name: TOPOLOGY_METRIC_NAMES.diagnosticResults,
  help: 'Diagnostic results returned by agents: accepted, rejected (authority/attribution refused), late (run already terminal) or duplicate',
  labelNames: ['recipe', 'status'] as const,
  registers: [metricsRegistry],
});

const diagnosticRunsExpired = new Counter({
  name: TOPOLOGY_METRIC_NAMES.diagnosticRunsExpired,
  help: 'Abandoned diagnostic runs the orphan sweeper expired (deadline, dispatch timeout or unconfirmed cancellation)',
  registers: [metricsRegistry],
});

const schedulerOccurrences = new Counter({
  name: TOPOLOGY_METRIC_NAMES.schedulerOccurrences,
  help: 'Recurring monitoring policy slots: dispatched runs, quota_gap (slot recorded as a gap), skipped (stale/transient) and disarmed policies',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

const assessments = new Counter({
  name: TOPOLOGY_METRIC_NAMES.assessments,
  help: 'Monitoring occurrences applied to health streaks, and the site-owned alerts they opened or recovered',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

const historyBuckets = new Histogram({
  name: TOPOLOGY_METRIC_NAMES.historyBuckets,
  help: 'Buckets returned per interface history read, by resolution',
  labelNames: ['resolution'] as const,
  buckets: [12, 48, 96, 288, 720, 1440, 2016],
  registers: [metricsRegistry],
});

/** Metrics must never break the path they observe. */
function safely(what: string, record: () => void): void {
  try {
    record();
  } catch (error) {
    console.error(`[TopologyMetrics] Failed to record ${what}:`, error);
  }
}

export function recordTopologyTelemetryBatch(input: {
  status: TopologyTelemetryBatchStatus;
  inserted: number;
  duplicates: number;
  historicalOnly: number;
  bytes?: number;
  lagSeconds?: number;
}): void {
  safely('telemetry batch', () => {
    telemetryBatches.inc({ status: bounded(TELEMETRY_BATCH_STATUSES, input.status) });
    // historical_only is a subset of inserted; count only the current remainder as inserted.
    const historical = positiveCount(input.historicalOnly) ? input.historicalOnly : 0;
    const current = positiveCount(input.inserted) ? input.inserted - historical : 0;
    if (current > 0) telemetrySamples.inc({ status: 'inserted' }, current);
    if (historical > 0) telemetrySamples.inc({ status: 'historical_only' }, historical);
    if (positiveCount(input.duplicates)) telemetrySamples.inc({ status: 'duplicate' }, input.duplicates);
    if (input.bytes !== undefined && positiveCount(input.bytes)) telemetryBatchBytes.observe(input.bytes);
    if (input.lagSeconds !== undefined && Number.isFinite(input.lagSeconds)) telemetryLag.observe(Math.max(0, input.lagSeconds));
  });
}

export function recordTopologyTelemetrySourceSwitch(): void {
  safely('telemetry source switch', () => telemetrySourceSwitches.inc());
}

export function recordTopologyDiagnosticDispatch(recipe: TopologyMetricRecipe, status: TopologyDispatchStatus, seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  safely('diagnostic dispatch', () => dispatchDuration.observe({ recipe: bounded(RECIPES, recipe), status: bounded(DISPATCH_STATUSES, status) }, seconds));
}

export function recordTopologyDiagnosticResult(recipe: TopologyMetricRecipe, status: TopologyResultStatus): void {
  safely('diagnostic result', () => diagnosticResults.inc({ recipe: bounded(RECIPES, recipe), status: bounded(RESULT_STATUSES, status) }));
}

export function recordTopologyDiagnosticSweep(expired: number): void {
  if (!positiveCount(expired)) return;
  safely('diagnostic sweep', () => diagnosticRunsExpired.inc(expired));
}

export function recordTopologySchedulerOccurrences(status: TopologySchedulerStatus, count: number): void {
  if (!positiveCount(count)) return;
  safely('scheduler occurrences', () => schedulerOccurrences.inc({ status: bounded(SCHEDULER_STATUSES, status) }, count));
}

export function recordTopologyAssessment(status: TopologyAssessmentStatus, count: number): void {
  if (!positiveCount(count)) return;
  safely('assessment', () => assessments.inc({ status: bounded(ASSESSMENT_STATUSES, status) }, count));
}

export function recordTopologyHistoryRead(resolution: TopologyHistoryResolution, buckets: number): void {
  if (!Number.isFinite(buckets) || buckets < 0) return;
  safely('history read', () => historyBuckets.observe({ resolution: bounded(RESOLUTIONS, resolution) }, buckets));
}
