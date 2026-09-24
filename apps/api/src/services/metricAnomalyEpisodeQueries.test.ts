import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import {
  serializeMetricAnomalyEpisode,
  serializeMetricAnomalyEpisodeMember,
  type MetricAnomalyEpisodeRow,
} from './metricAnomalyEpisodeQueries';

const NOW = new Date('2026-09-22T00:30:00.000Z');

function row(overrides: Partial<MetricAnomalyEpisodeRow> = {}): MetricAnomalyEpisodeRow {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    orgId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222',
    episodeKey: 'device_metrics:spike:disk_write',
    sourceTable: 'device_metrics',
    anomalyType: 'spike',
    metricFamily: 'disk_write',
    metricNames: ['disk_write_bps'],
    status: 'open',
    closeReason: null,
    firstSeenAt: new Date('2026-09-21T22:35:00.000Z'),
    lastSeenAt: new Date('2026-09-21T23:55:00.000Z'),
    bucketCount: 17,
    peakValue: 153_000_000,
    peakMetricName: 'disk_write_bps',
    peakBaselineValue: 6_000_000,
    peakScore: 9.1,
    peakAt: new Date('2026-09-21T23:10:00.000Z'),
    recurrenceCount: 0,
    attribution: null,
    linkedAlertId: null,
    snoozedUntil: null,
    resolvedAt: null,
    resolvedByUserId: null,
    note: null,
    createdAt: new Date('2026-09-21T22:40:00.000Z'),
    updatedAt: new Date('2026-09-21T23:56:00.000Z'),
    ...overrides,
  } as MetricAnomalyEpisodeRow;
}

describe('serializeMetricAnomalyEpisode', () => {
  it('maps every column to camelCase ISO output and derives duration/ongoing/promoted/snoozed', () => {
    const dto = serializeMetricAnomalyEpisode(row(), { min: 86_000_000, max: 153_000_000 }, NOW);
    expect(dto).toMatchObject({
      id: '55555555-5555-4555-8555-555555555555',
      episodeKey: 'device_metrics:spike:disk_write',
      metricNames: ['disk_write_bps'],
      status: 'open',
      closeReason: null,
      firstSeenAt: '2026-09-21T22:35:00.000Z',
      lastSeenAt: '2026-09-21T23:55:00.000Z',
      peakAt: '2026-09-21T23:10:00.000Z',
      bucketCount: 17,
      durationSeconds: 4800,
      ongoing: true,
      promoted: false,
      snoozed: false,
      snoozedUntil: null,
      resolvedAt: null,
      rangeMin: 86_000_000,
      rangeMax: 153_000_000,
    });
  });

  it('returns null range fields when no member range is known', () => {
    const dto = serializeMetricAnomalyEpisode(row(), undefined, NOW);
    expect(dto.rangeMin).toBeNull();
    expect(dto.rangeMax).toBeNull();
    expect(dto.peakAnomalyId).toBeNull();
  });

  it('carries the peak member id for remediation lookups', () => {
    const dto = serializeMetricAnomalyEpisode(row(), { min: 1, max: 2, peakAnomalyId: '33333333-3333-4333-8333-333333333333' }, NOW);
    expect(dto.peakAnomalyId).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('marks a dismissed episode with a future snooze as snoozed and not ongoing', () => {
    const dto = serializeMetricAnomalyEpisode(row({
      status: 'dismissed',
      closeReason: 'user',
      resolvedAt: new Date('2026-09-22T00:00:00.000Z'),
      snoozedUntil: new Date('2026-09-29T00:00:00.000Z'),
    }), null, NOW);
    expect(dto.ongoing).toBe(false);
    expect(dto.snoozed).toBe(true);
    expect(dto.snoozedUntil).toBe('2026-09-29T00:00:00.000Z');
  });

  it('an expired snooze is not snoozed', () => {
    const dto = serializeMetricAnomalyEpisode(row({
      status: 'dismissed',
      closeReason: 'user',
      resolvedAt: new Date('2026-09-10T00:00:00.000Z'),
      snoozedUntil: new Date('2026-09-17T00:00:00.000Z'),
    }), null, NOW);
    expect(dto.snoozed).toBe(false);
  });

  it('promoted follows linkedAlertId, independent of status', () => {
    const dto = serializeMetricAnomalyEpisode(row({ linkedAlertId: '44444444-4444-4444-8444-444444444444' }), null, NOW);
    expect(dto.promoted).toBe(true);
    expect(dto.ongoing).toBe(true);
  });

  it('carries the device last-seen time for the expired_offline chip (A9)', () => {
    const lastSeen = new Date('2026-09-20T08:00:00.000Z');
    expect(serializeMetricAnomalyEpisode(row(), null, NOW, lastSeen).deviceLastSeenAt).toBe('2026-09-20T08:00:00.000Z');
    expect(serializeMetricAnomalyEpisode(row(), null, NOW).deviceLastSeenAt).toBeNull();
  });

  it('never reports a negative duration', () => {
    const t = new Date('2026-09-21T22:35:00.000Z');
    expect(serializeMetricAnomalyEpisode(row({ firstSeenAt: t, lastSeenAt: t }), null, NOW).durationSeconds).toBe(0);
  });
});

describe('serializeMetricAnomalyEpisodeMember', () => {
  it('serializes the member-table columns', () => {
    const dto = serializeMetricAnomalyEpisodeMember({
      id: '33333333-3333-4333-8333-333333333333',
      metricName: 'disk_write_bps',
      anomalyType: 'spike',
      status: 'open',
      windowStart: new Date('2026-09-21T22:35:00.000Z'),
      windowEnd: new Date('2026-09-21T22:40:00.000Z'),
      observedValue: 86_000_000,
      baselineValue: 5_500_000,
      baselineMax: 11_000_000,
      score: 6.2,
      confidence: 0.82,
      linkedAlertId: null,
    } as never);
    expect(dto).toEqual({
      id: '33333333-3333-4333-8333-333333333333',
      metricName: 'disk_write_bps',
      anomalyType: 'spike',
      status: 'open',
      windowStart: '2026-09-21T22:35:00.000Z',
      windowEnd: '2026-09-21T22:40:00.000Z',
      observedValue: 86_000_000,
      baselineValue: 5_500_000,
      baselineMax: 11_000_000,
      score: 6.2,
      confidence: 0.82,
      linkedAlertId: null,
    });
  });
});
