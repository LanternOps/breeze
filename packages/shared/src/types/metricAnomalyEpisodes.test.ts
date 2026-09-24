import { describe, expect, expectTypeOf, it } from 'vitest';
import * as shared from './index';
import {
  ATTRIBUTION_DIMENSIONS,
  EPISODE_ACTIONS,
  EPISODE_CLOSE_REASONS,
  EPISODE_DETAIL_MEMBER_LIMIT,
  EPISODE_LIST_STATUSES,
  METRIC_ANOMALY_EPISODE_STATUSES,
  METRIC_ANOMALY_STATUSES,
  type EpisodeAction,
  type EpisodeAttribution,
  type MetricAnomalyEpisodeDetailDto,
  type MetricAnomalyEpisodeDto,
  type MetricAnomalyEpisodeListResponse,
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

describe('metric anomaly episode API contract (W02)', () => {
  it('exposes exactly the four spec §8.1 actions, in order', () => {
    expect([...EPISODE_ACTIONS]).toEqual(['resolve', 'dismiss', 'promote', 'unsnooze']);
    expectTypeOf<EpisodeAction>().toEqualTypeOf<'resolve' | 'dismiss' | 'promote' | 'unsnooze'>();
  });

  it('exposes the three list filters of spec §12', () => {
    expect([...EPISODE_LIST_STATUSES]).toEqual(['open', 'closed', 'all']);
  });

  it('caps detail members at 200 (spec §12)', () => {
    expect(EPISODE_DETAIL_MEMBER_LIMIT).toBe(200);
  });

  it('DTO carries the derived fields the web card needs', () => {
    expectTypeOf<MetricAnomalyEpisodeDto['durationSeconds']>().toEqualTypeOf<number>();
    expectTypeOf<MetricAnomalyEpisodeDto['ongoing']>().toEqualTypeOf<boolean>();
    expectTypeOf<MetricAnomalyEpisodeDto['promoted']>().toEqualTypeOf<boolean>();
    expectTypeOf<MetricAnomalyEpisodeDto['snoozed']>().toEqualTypeOf<boolean>();
    expectTypeOf<MetricAnomalyEpisodeDto['rangeMin']>().toEqualTypeOf<number | null>();
    expectTypeOf<MetricAnomalyEpisodeDto['rangeMax']>().toEqualTypeOf<number | null>();
    expectTypeOf<MetricAnomalyEpisodeDto['firstSeenAt']>().toEqualTypeOf<string>();
    expectTypeOf<MetricAnomalyEpisodeDto['peakAnomalyId']>().toEqualTypeOf<string | null>();
    expectTypeOf<MetricAnomalyEpisodeDto['deviceLastSeenAt']>().toEqualTypeOf<string | null>();
    expectTypeOf<MetricAnomalyEpisodeDetailDto['membersTruncated']>().toEqualTypeOf<boolean>();
    expectTypeOf<MetricAnomalyEpisodeListResponse['focusedEpisodeId']>().toEqualTypeOf<string | null>();
  });
});
