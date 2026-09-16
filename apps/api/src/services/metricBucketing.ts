/**
 * Bucketing and caps for GET /monitoring/assets/:id/metrics (spec §6.3).
 *
 * Pure so the cap arithmetic is testable without a database — the caps are the
 * only thing standing between a chart tab and a 90-day sequential scan of a
 * table that takes ~138k rows a day per walked switch once W02 ships.
 */

export type BucketChoice = 'auto' | '1m' | '5m' | '1h' | '1d';

export const MAX_RANGE_DAYS = 90;
export const MAX_POINTS_PER_SERIES = 2000;
export const MAX_SERIES = 64;

const SECONDS: Record<Exclude<BucketChoice, 'auto'>, number> = { '1m': 60, '5m': 300, '1h': 3600, '1d': 86400 };

export function bucketSeconds(bucket: Exclude<BucketChoice, 'auto'>): number {
  return SECONDS[bucket];
}

/** Widest bucket that still shows detail, narrow enough to stay under the cap. */
export function chooseBucket(fromMs: number, toMs: number): Exclude<BucketChoice, 'auto'> {
  const hours = (toMs - fromMs) / 3600_000;
  if (hours <= 6) return '1m';
  if (hours <= 48) return '5m';
  if (hours <= 24 * 30) return '1h';
  return '1d';
}

export function validateRange(
  fromMs: number,
  toMs: number,
  bucket: BucketChoice,
): { ok: true; bucket: Exclude<BucketChoice, 'auto'>; seconds: number } | { ok: false; message: string } {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return { ok: false, message: 'from and to must be valid ISO timestamps' };
  }
  if (toMs <= fromMs) return { ok: false, message: 'to must be after from' };
  const rangeDays = (toMs - fromMs) / 86_400_000;
  if (rangeDays > MAX_RANGE_DAYS) {
    return { ok: false, message: `Requested range exceeds the ${MAX_RANGE_DAYS}-day cap` };
  }
  const chosen = bucket === 'auto' ? chooseBucket(fromMs, toMs) : bucket;
  const seconds = SECONDS[chosen];
  const points = (toMs - fromMs) / 1000 / seconds;
  if (points > MAX_POINTS_PER_SERIES) {
    return {
      ok: false,
      message: `Bucket ${chosen} over this range yields ${Math.ceil(points)} points, above the ${MAX_POINTS_PER_SERIES}-point cap; widen the bucket or shorten the range`,
    };
  }
  return { ok: true, bucket: chosen, seconds };
}

/** Counters aggregate with max (they only ever climb); gauges with avg. */
export function isCounterType(type: string | undefined): boolean {
  return typeof type === 'string' && type.toLowerCase().startsWith('counter');
}

/**
 * Reset-aware first differences. A DECREASE means the counter wrapped or the
 * device restarted, not negative traffic — take the new value as the delta,
 * which is the standard SNMP treatment and cannot render as a downward spike.
 */
export function toResetAwareDeltas(points: Array<[string, number]>): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (let i = 1; i < points.length; i++) {
    const [ts, current] = points[i]!;
    const previous = points[i - 1]![1];
    out.push([ts, current >= previous ? current - previous : current]);
  }
  return out;
}
