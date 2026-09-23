/**
 * Metric anomaly episode counters (spec §7, §10).
 *
 * A LEAF module: `prom-client` plus `./metricsRegistry`, nothing else — same
 * shape and reason as aiOperatorOutboxMetrics.ts. Detection runs in the WORKER
 * role, which never loads routes/metrics.ts; registering here is what makes the
 * series appear in the process that produces it.
 */
import { Counter } from 'prom-client';

import { metricsRegistry } from './metricsRegistry';

export const EPISODE_STAGE_SKIPPED_METRIC = 'metric_anomaly_episode_stage_skipped_total';
export const BASELINE_FALLBACK_METRIC = 'metric_anomaly_baseline_fallback_total';

/** A whole-org episode stage hit its lock/statement timeout. A steady rise means open episodes are not clearing. */
const stageSkipped = new Counter({
  name: EPISODE_STAGE_SKIPPED_METRIC,
  help: 'Metric anomaly episode stages (assembly, auto-resolve) skipped on a lock or statement timeout',
  labelNames: ['stage'] as const,
  registers: [metricsRegistry],
});

/** (device, metric) pairs whose open-episode-filtered baseline was too short, so the unfiltered one was used. */
const baselineFallback = new Counter({
  name: BASELINE_FALLBACK_METRIC,
  help: 'Device+metric pairs that fell back to the unfiltered baseline because excluding open-episode buckets left fewer than MIN_BASELINE_BUCKETS',
  labelNames: ['detector'] as const,
  registers: [metricsRegistry],
});

export function recordEpisodeStageSkipped(stage: 'episodes' | 'episode-resolve'): void {
  try {
    stageSkipped.inc({ stage });
  } catch (error) {
    console.error('[MetricAnomalyEpisodes] Failed to record stage skip:', error);
  }
}

export function recordBaselineFallback(detector: 'baseline' | 'process-runaway', pairs: number): void {
  if (!Number.isFinite(pairs) || pairs <= 0) return;
  try {
    baselineFallback.inc({ detector }, pairs);
  } catch (error) {
    console.error('[MetricAnomalyEpisodes] Failed to record baseline fallback:', error);
  }
}
