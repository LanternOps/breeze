import { describe, expect, it } from 'vitest';
import { normalizeMetricAnomalyContext } from './alertMlContext';

describe('normalizeMetricAnomalyContext', () => {
  it('returns null for a non-metric_anomaly context', () => {
    expect(normalizeMetricAnomalyContext({ source: 'other' })).toBeNull();
    expect(normalizeMetricAnomalyContext(null)).toBeNull();
    expect(normalizeMetricAnomalyContext(undefined)).toBeNull();
  });

  it('parses episodeId alongside the legacy anomalyId', () => {
    const result = normalizeMetricAnomalyContext({
      source: 'metric_anomaly',
      anomalyId: 'anomaly-1',
      episodeId: 'episode-1',
      metricName: 'cpu_percent',
      metricType: 'system',
      anomalyType: 'spike',
      observedValue: 96.4,
      baselineValue: 42.2,
      confidence: 0.91,
      score: 8.1,
      modelVersion: null,
    });
    expect(result).toMatchObject({ anomalyId: 'anomaly-1', episodeId: 'episode-1' });
  });

  it('defaults episodeId to null when absent (pre-W02 alerts)', () => {
    const result = normalizeMetricAnomalyContext({
      source: 'metric_anomaly',
      anomalyId: 'anomaly-1',
    });
    expect(result?.episodeId).toBeNull();
  });

  it('rejects a non-string episodeId', () => {
    const result = normalizeMetricAnomalyContext({ source: 'metric_anomaly', episodeId: 42 });
    expect(result?.episodeId).toBeNull();
  });
});
