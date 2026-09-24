import { describe, expect, it } from 'vitest';
import {
  groupKeyOf,
  memberStatusFor,
  planEpisodeAssembly,
  type AnchorEpisode,
  type UnassignedAnomalyRow,
} from './metricAnomalyEpisodePlanner';

const DEVICE = 'dddddddd-0000-4000-8000-000000000001';
const T0 = Date.parse('2026-09-21T22:00:00.000Z');
const CPU_KEY = 'device_metrics:spike:cpu';
const m = (minutes: number): Date => new Date(T0 + minutes * 60_000);

let rowSeq = 0;
function row(atMinute: number, overrides: Partial<UnassignedAnomalyRow> = {}): UnassignedAnomalyRow {
  rowSeq += 1;
  return {
    id: `row-${rowSeq}`,
    deviceId: DEVICE,
    sourceTable: 'device_metrics',
    anomalyType: 'spike',
    metricName: 'cpu_percent',
    windowStart: m(atMinute),
    windowEnd: m(atMinute + 5),
    score: 5,
    observedValue: 95,
    baselineValue: 40,
    ...overrides,
  };
}

function anchor(first: number, last: number, overrides: Partial<AnchorEpisode> = {}): AnchorEpisode {
  return { id: 'ep-1', deviceId: DEVICE, episodeKey: CPU_KEY, status: 'open', firstSeenAt: m(first), lastSeenAt: m(last), ...overrides };
}

function plan(rows: UnassignedAnomalyRow[], anchors: AnchorEpisode[] = [], snoozes = new Map<string, Date>()) {
  let n = 0;
  return planEpisodeAssembly({ rows, anchors, activeSnoozes: snoozes, gapMinutes: 30, newId: () => `new-${++n}` });
}

describe('planEpisodeAssembly (spec §5, §6)', () => {
  it('opens one episode for a contiguous 17-bucket burst and summarises it', () => {
    const rows = Array.from({ length: 17 }, (_, i) => row(i * 5, i === 8 ? { score: 20, observedValue: 153, baselineValue: 11 } : {}));
    const result = plan(rows);
    expect(result.supersedes).toEqual([]);
    expect(result.anchorAttaches).toEqual([]);
    expect(result.creates).toHaveLength(1);
    expect(result.creates[0]).toMatchObject({
      id: 'new-1',
      episodeKey: CPU_KEY,
      metricFamily: 'cpu',
      attributionDimension: 'cpu',
      disposition: 'open',
      bucketCount: 17,
      firstSeenAt: m(0),
      lastSeenAt: m(85),
      peakScore: 20,
      peakValue: 153,
      peakBaselineValue: 11,
      peakMetricName: 'cpu_percent',
      peakAt: m(40),
      priorInBatch: 0,
      cleanUntil: null,
      snoozedUntil: null,
    });
    expect(result.creates[0]!.memberIds).toHaveLength(17);
  });

  it('attaches a bucket that starts exactly EPISODE_GAP_MINUTES after the episode ends', () => {
    const inside = row(45);
    const result = plan([inside], [anchor(0, 15)]);
    expect(result.creates).toEqual([]);
    expect(result.supersedes).toEqual([]);
    expect(result.anchorAttaches).toEqual([
      { anomalyId: inside.id, episodeId: 'ep-1', memberStatus: 'open', attributionDimension: 'cpu' },
    ]);
  });

  it('a bucket 31 minutes after the episode ends supersedes it and opens a new episode', () => {
    const outside = row(46);
    const result = plan([outside], [anchor(0, 15)]);
    expect(result.anchorAttaches).toEqual([]);
    expect(result.supersedes).toEqual([{ episodeId: 'ep-1', cleanUntil: m(46) }]);
    expect(result.creates).toHaveLength(1);
    expect(result.creates[0]).toMatchObject({ disposition: 'open', memberIds: [outside.id], priorInBatch: 0 });
  });

  it('chains buckets that each sit within the gap of the previous one', () => {
    const rows = [row(40), row(70), row(100)];
    const result = plan(rows, [anchor(0, 15)]);
    expect(result.anchorAttaches.map((a) => a.anomalyId)).toEqual(rows.map((r) => r.id));
    expect(result.creates).toEqual([]);
  });

  it('a backfill orphan before first_seen_at − gap becomes its own closed episode; a near one attaches', () => {
    const orphan = row(0);
    const near = row(85); // ends at 90, gap 30 to the anchor's first_seen_at (120)
    const result = plan([orphan, near], [anchor(120, 135)]);
    expect(result.anchorAttaches.map((a) => a.anomalyId)).toEqual([near.id]);
    expect(result.supersedes).toEqual([]);
    expect(result.creates).toHaveLength(1);
    expect(result.creates[0]).toMatchObject({ disposition: 'historical', memberIds: [orphan.id], cleanUntil: m(85), priorInBatch: 0 });
  });

  it('merges the process ram pair and counts distinct buckets, not rows', () => {
    const rows = [0, 5, 10].flatMap((t) => [
      row(t, { sourceTable: 'device_process_samples', anomalyType: 'process_runaway', metricName: 'top_process_ram_mb_sum', score: 4 }),
      row(t, { sourceTable: 'device_process_samples', anomalyType: 'process_runaway', metricName: 'top_process_ram_mb_max', score: t === 5 ? 9 : 3 }),
    ]);
    const result = plan(rows);
    expect(result.creates).toHaveLength(1);
    expect(result.creates[0]).toMatchObject({
      episodeKey: 'device_process_samples:process_runaway:process_ram',
      metricNames: ['top_process_ram_mb_max', 'top_process_ram_mb_sum'],
      bucketCount: 3,
      peakMetricName: 'top_process_ram_mb_max',
      peakAt: m(5),
      attributionDimension: 'ramMb',
    });
    expect(result.creates[0]!.memberIds).toHaveLength(6);
  });

  it('keeps two devices with the same episode key and timing in separate episodes', () => {
    const other = 'dddddddd-0000-4000-8000-000000000002';
    const mine = row(0);
    const theirs = row(0, { deviceId: other });
    const result = plan([mine, theirs], [anchor(0, 15)]);
    // The anchor belongs to DEVICE only: the other device's row must not attach to it.
    expect(result.anchorAttaches.map((a) => a.anomalyId)).toEqual([mine.id]);
    expect(result.creates).toHaveLength(1);
    expect(result.creates[0]).toMatchObject({ deviceId: other, memberIds: [theirs.id], disposition: 'open' });
  });

  it('keeps network_egress from the device series and the process series apart', () => {
    const result = plan([
      row(0, { anomalyType: 'network_egress', metricName: 'bandwidth_out_bps' }),
      row(0, { anomalyType: 'network_egress', sourceTable: 'device_process_samples', metricName: 'top_process_net_bps_sum' }),
    ]);
    expect(result.creates.map((c) => c.episodeKey).sort()).toEqual([
      'device_metrics:network_egress:net_out',
      'device_process_samples:network_egress:process_net',
    ]);
  });

  it('in one batch, older islands close, the newest opens, and recurrence offsets count up', () => {
    const result = plan([row(0), row(60), row(120)]);
    expect(result.creates.map((c) => [c.disposition, c.priorInBatch, c.cleanUntil])).toEqual([
      ['historical', 0, m(60)],
      ['historical', 1, m(120)],
      ['open', 2, null],
    ]);
  });

  it('a live snooze creates the new episode already dismissed', () => {
    const until = m(7 * 24 * 60);
    const result = plan([row(0)], [], new Map([[groupKeyOf(DEVICE, CPU_KEY), until]]));
    expect(result.creates[0]).toMatchObject({ disposition: 'snoozed', snoozedUntil: until, cleanUntil: null });
  });

  it('under a live snooze, a non-head island is historical, not snoozed (A3)', () => {
    const until = m(7 * 24 * 60);
    const result = plan([row(0), row(60)], [], new Map([[groupKeyOf(DEVICE, CPU_KEY), until]]));
    expect(result.creates.map((c) => [c.disposition, c.snoozedUntil, c.cleanUntil])).toEqual([
      ['historical', null, m(60)],
      ['snoozed', until, null],
    ]);
  });

  it('under a live snooze, a backfill orphan older than the snoozed anchor is historical (A3)', () => {
    const orphan = row(0);
    const result = plan([orphan], [anchor(120, 135, { status: 'dismissed' })], new Map([[groupKeyOf(DEVICE, CPU_KEY), m(10_000)]]));
    expect(result.anchorAttaches).toEqual([]);
    expect(result.creates).toHaveLength(1);
    expect(result.creates[0]).toMatchObject({ disposition: 'historical', memberIds: [orphan.id], snoozedUntil: null });
  });

  it('extends a live snoozed successor and dismisses its new members', () => {
    const next = row(10);
    const result = plan([next], [anchor(0, 5, { status: 'dismissed' })], new Map([[groupKeyOf(DEVICE, CPU_KEY), m(10_000)]]));
    expect(result.anchorAttaches).toEqual([
      { anomalyId: next.id, episodeId: 'ep-1', memberStatus: 'dismissed', attributionDimension: 'cpu' },
    ]);
    expect(result.creates).toEqual([]);
    expect(result.supersedes).toEqual([]);
  });

  it('prefers the open anchor when a snoozed successor for the same key also exists', () => {
    const next = row(20);
    const result = plan([next], [
      anchor(0, 5, { id: 'snoozed', status: 'dismissed' }),
      anchor(0, 15, { id: 'open' }),
    ]);
    expect(result.anchorAttaches.map((a) => a.episodeId)).toEqual(['open']);
  });

  it('gives a tied peak to the earliest bucket', () => {
    const result = plan([row(0, { score: 7 }), row(5, { score: 7 })]);
    expect(result.creates[0]!.peakAt).toEqual(m(0));
  });

  it('maps a disposition to the status its members take', () => {
    expect(memberStatusFor('open')).toBe('open');
    expect(memberStatusFor('snoozed')).toBe('dismissed');
    expect(memberStatusFor('historical')).toBe('cleared');
  });
});
