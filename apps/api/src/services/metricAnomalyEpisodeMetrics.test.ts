import { beforeEach, describe, expect, it } from 'vitest';
import { metricsRegistry } from './metricsRegistry';
import {
  BASELINE_FALLBACK_METRIC,
  EPISODE_STAGE_SKIPPED_METRIC,
  recordBaselineFallback,
  recordEpisodeStageSkipped,
} from './metricAnomalyEpisodeMetrics';

beforeEach(() => {
  metricsRegistry.resetMetrics();
});

describe('metric anomaly episode counters (spec §7, §10)', () => {
  it('counts skipped episode stages by stage', async () => {
    recordEpisodeStageSkipped('episodes');
    recordEpisodeStageSkipped('episode-resolve');
    recordEpisodeStageSkipped('episode-resolve');
    const text = await metricsRegistry.metrics();
    expect(EPISODE_STAGE_SKIPPED_METRIC).toBe('metric_anomaly_episode_stage_skipped_total');
    expect(text).toContain('metric_anomaly_episode_stage_skipped_total{stage="episodes"} 1');
    expect(text).toContain('metric_anomaly_episode_stage_skipped_total{stage="episode-resolve"} 2');
  });

  it('adds baseline fallbacks by detector and ignores zero, negative and non-finite counts', async () => {
    recordBaselineFallback('baseline', 2);
    recordBaselineFallback('process-runaway', 1);
    recordBaselineFallback('baseline', 0);
    recordBaselineFallback('baseline', -3);
    recordBaselineFallback('baseline', Number.NaN);
    const text = await metricsRegistry.metrics();
    expect(BASELINE_FALLBACK_METRIC).toBe('metric_anomaly_baseline_fallback_total');
    expect(text).toContain('metric_anomaly_baseline_fallback_total{detector="baseline"} 2');
    expect(text).toContain('metric_anomaly_baseline_fallback_total{detector="process-runaway"} 1');
    expect(text).not.toContain('NaN');
  });
});
