import { describe, expect, it } from 'vitest';
import { bucketSeconds, chooseBucket, validateRange, isCounterType, toResetAwareDeltas, MAX_POINTS_PER_SERIES } from './metricBucketing';

const H = 3600_000;
const D = 24 * H;

describe('chooseBucket', () => {
  it.each([
    [6 * H, '1m'],
    [2 * D, '5m'],
    [30 * D, '1h'],
    [90 * D, '1d'],
  ] as const)('a %i ms range picks %s', (range, expected) => {
    expect(chooseBucket(0, range)).toBe(expected);
  });
});

describe('validateRange', () => {
  it('rejects a range beyond 90 days and names the cap', () => {
    const r = validateRange(0, 91 * D, 'auto');
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain('90');
  });

  it('rejects an inverted range', () => {
    expect(validateRange(D, 0, 'auto').ok).toBe(false);
  });

  it('rejects an explicit bucket that would exceed the point cap and names it', () => {
    const r = validateRange(0, 30 * D, '1m');
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain(String(MAX_POINTS_PER_SERIES));
  });

  it('accepts an explicit bucket inside the caps', () => {
    expect(validateRange(0, 24 * H, '1m')).toEqual({ ok: true, bucket: '1m', seconds: 60 });
  });

  it('auto never exceeds the point cap over the full 90-day range', () => {
    const r = validateRange(0, 90 * D, 'auto');
    expect(r.ok).toBe(true);
    expect((90 * D) / 1000 / bucketSeconds((r as { bucket: '1d' }).bucket)).toBeLessThanOrEqual(MAX_POINTS_PER_SERIES);
  });
});

describe('isCounterType', () => {
  it.each([['counter32', true], ['counter64', true], ['gauge32', false], [undefined, false]] as const)(
    '%s -> %s', (type, expected) => expect(isCounterType(type)).toBe(expected),
  );
});

describe('toResetAwareDeltas', () => {
  it('differences consecutive points', () => {
    expect(toResetAwareDeltas([['t1', 10], ['t2', 30], ['t3', 45]])).toEqual([['t2', 20], ['t3', 15]]);
  });

  it('treats a decrease as a counter reset and takes the new value', () => {
    // A 32-bit counter wrapping, or an agent restart. A negative "delta" on a
    // byte counter would render as traffic flowing backwards.
    expect(toResetAwareDeltas([['t1', 100], ['t2', 5]])).toEqual([['t2', 5]]);
  });

  it('returns an empty series for fewer than two points', () => {
    expect(toResetAwareDeltas([['t1', 1]])).toEqual([]);
    expect(toResetAwareDeltas([])).toEqual([]);
  });
});
