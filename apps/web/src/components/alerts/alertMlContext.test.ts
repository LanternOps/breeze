import { describe, expect, it } from 'vitest';
import { anomalyDeepLinkHash, normalizeMetricAnomalyContext } from './alertMlContext';

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

describe('anomalyDeepLinkHash', () => {
  const base = normalizeMetricAnomalyContext({ source: 'metric_anomaly' })!;

  it('prefers the episode id over the legacy anomaly id', () => {
    expect(anomalyDeepLinkHash({ ...base, episodeId: 'ep-1', anomalyId: 'an-1' })).toBe('anomalies/ep-1');
  });

  it('falls back to the legacy anomaly id when there is no episode', () => {
    expect(anomalyDeepLinkHash({ ...base, episodeId: null, anomalyId: 'an-1' })).toBe('anomalies/an-1');
  });

  it('links to the bare tab when neither id is present', () => {
    expect(anomalyDeepLinkHash({ ...base, episodeId: null, anomalyId: null })).toBe('anomalies');
  });
});
