import { describe, expect, it } from 'vitest';
import { aggregateFiveMinuteBuckets, aggregateHourlyBuckets, type RollupSample } from './interfaceRollups';

const IF = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const T0 = Date.parse('2026-09-15T00:00:00Z');
const MIN = 60_000;
const at = (ms: number) => new Date(T0 + ms);

/** Samples every `step` ms from `start`, octets advancing so each window carries `bps(i)`. */
function series(opts: { start?: number; count: number; step?: number; bps?: (i: number) => number; over?: (i: number) => Partial<RollupSample> }): RollupSample[] {
  const { start = 0, count, step = MIN, bps = () => 1000, over = () => ({}) } = opts;
  let octets = 0n;
  return Array.from({ length: count }, (_, i) => {
    if (i > 0) octets += BigInt(Math.round(bps(i) * step / 8000));
    return {
      interfaceId: IF, interfaceEpoch: 'gen:1', sourceId: SOURCE, producerEpoch: 'epoch-a', expectedIntervalSeconds: step / 1000, sourceSequence: String(i + 1),
      sampledAt: at(start + i * step).toISOString(), counterWidth: 64, inOctets: octets.toString(), outOctets: '0',
      inErrors: '0', outErrors: '0', inDiscards: '0', outDiscards: '0', inPackets: null, outPackets: null,
      capacityBps: '1000000', discontinuityTicks: '0', deviceUptimeTicks: String(1000 + (start + i * step) / 10), adminStatus: 'up', operStatus: 'up',
      ...over(i),
    };
  });
}
const range = (fromMs: number, toMs: number) => ({ from: at(fromMs), to: at(toMs) });

describe('aggregateFiveMinuteBuckets', () => {
  it('aggregates closed buckets with duration-weighted means, counts and coverage', () => {
    const rows = aggregateFiveMinuteBuckets(series({ count: 11 }), range(0, 10 * MIN));
    expect(rows.map(r => r.bucketStart.toISOString())).toEqual([at(0).toISOString(), at(5 * MIN).toISOString()]);
    const [first] = rows;
    expect(first).toMatchObject({ resolution: '5m', interfaceId: IF, interfaceEpoch: 'gen:1', sourceId: SOURCE, producerEpoch: 'epoch-a',
      sampleCount: 5, validDurationMs: 5 * MIN, gapDurationMs: 0, sourceSequence: '6' });
    expect(first!.readings.series.in_bps).toEqual({ min: 1000, max: 1000, mean: 1000, validMs: 5 * MIN });
    expect(first!.readings.series.in_utilization_pct?.mean).toBeCloseTo(0.1);
  });

  it('weights the mean by duration and keeps min/max', () => {
    const rows = aggregateFiveMinuteBuckets(series({ count: 6, bps: i => (i === 1 ? 1000 : 3000) }), range(0, 5 * MIN));
    expect(rows[0]!.readings.series.in_bps).toEqual({ min: 1000, max: 3000, mean: 2600, validMs: 5 * MIN });
  });

  it('splits a window across a bucket boundary by duration', () => {
    const rows = aggregateFiveMinuteBuckets(series({ start: 4 * MIN + 30_000, count: 2 }), range(0, 10 * MIN));
    expect(rows.map(r => [r.bucketStart.getTime() - T0, r.validDurationMs, r.sampleCount])).toEqual([[0, 30_000, 1], [5 * MIN, 30_000, 1]]);
  });

  it('never bridges a gap or a generation change and records it as gap time', () => {
    const gapped = [...series({ count: 2 }), ...series({ start: 4 * MIN + 1000, count: 1 })];
    gapped[2]!.inOctets = '999999';
    const rows = aggregateFiveMinuteBuckets(gapped, range(0, 5 * MIN));
    expect(rows[0]!.validDurationMs).toBe(MIN);
    expect(rows[0]!.gapDurationMs).toBe(4 * MIN);
    expect(rows[0]!.readings.invalid.gap).toBe(3 * MIN + 1000);

    const regenerated = series({ count: 4, over: i => (i >= 2 ? { interfaceEpoch: 'gen:2' } : {}) });
    const byEpoch = aggregateFiveMinuteBuckets(regenerated, range(0, 5 * MIN));
    expect(byEpoch.map(r => [r.interfaceEpoch, r.validDurationMs])).toEqual([['gen:1', MIN], ['gen:2', MIN]]);
  });

  it('counts observed state changes without asserting every flap', () => {
    const rows = aggregateFiveMinuteBuckets(series({ count: 5, over: i => ({ operStatus: i % 2 ? 'down' : 'up' }) }), range(0, 5 * MIN));
    expect(rows[0]!.readings.stateChanges).toBe(4);
    expect(rows[0]!.readings.operStatus).toBe('up');
  });

  it('emits only buckets inside the requested range and is deterministic', () => {
    const input = series({ count: 21 });
    const a = aggregateFiveMinuteBuckets(input, range(5 * MIN, 15 * MIN));
    expect(a.map(r => r.bucketStart.getTime() - T0)).toEqual([5 * MIN, 10 * MIN]);
    expect(aggregateFiveMinuteBuckets([...input].reverse(), range(5 * MIN, 15 * MIN))).toEqual(a);
  });
});

describe('aggregateHourlyBuckets', () => {
  it('combines 5-minute rows by validity-weighted mean, min/max and sums', () => {
    const five = aggregateFiveMinuteBuckets(series({ count: 61, bps: i => (i <= 30 ? 1000 : 3000) }), range(0, 60 * MIN));
    const [hour] = aggregateHourlyBuckets(five, range(0, 60 * MIN));
    expect(hour).toMatchObject({ resolution: '1h', sampleCount: 60, validDurationMs: 60 * MIN, gapDurationMs: 0, sourceSequence: '61' });
    expect(hour!.readings.series.in_bps).toEqual({ min: 1000, max: 3000, mean: 2000, validMs: 60 * MIN });
  });
});
