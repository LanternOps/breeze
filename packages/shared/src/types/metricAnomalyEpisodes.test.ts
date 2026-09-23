import { describe, expect, it } from 'vitest';
import * as shared from './index';
import {
  ATTRIBUTION_DIMENSIONS,
  EPISODE_CLOSE_REASONS,
  METRIC_ANOMALY_EPISODE_STATUSES,
  METRIC_ANOMALY_STATUSES,
  type EpisodeAttribution,
} from './metricAnomalyEpisodes';

describe('metric anomaly episode shared types (spec §4.1, §9)', () => {
  it('adds cleared to the per-bucket status domain', () => {
    expect(METRIC_ANOMALY_STATUSES).toEqual(['open', 'dismissed', 'promoted', 'resolved', 'cleared']);
  });

  it('keeps episode status and close reason separate (D6)', () => {
    expect(METRIC_ANOMALY_EPISODE_STATUSES).toEqual(['open', 'resolved', 'dismissed']);
    expect(EPISODE_CLOSE_REASONS).toEqual(['cleared', 'expired_offline', 'expired_no_data', 'detection_off', 'user', 'snoozed']);
  });

  it('names the agent TopProcess keys as attribution dimensions', () => {
    expect(ATTRIBUTION_DIMENSIONS).toEqual(['cpu', 'ramMb', 'diskBps', 'netBps']);
  });

  it('is exported from the types index', () => {
    expect(shared.METRIC_ANOMALY_STATUSES).toBe(METRIC_ANOMALY_STATUSES);
    const sample: EpisodeAttribution = {
      peak: { sampledAt: '2026-09-21T22:35:00.000Z', dimension: 'ramMb', processes: [{ name: 'chrome.exe', pid: 4120, value: 1932.5 }] },
    };
    expect(sample.opened).toBeUndefined();
  });
});
