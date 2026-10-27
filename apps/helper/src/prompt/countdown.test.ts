import { describe, expect, it } from 'vitest';

import { formatRemaining, remainingSeconds } from './countdown';

const T = 1_793_019_600_000;

describe('countdown', () => {
  it('formats the remaining time as M:SS with unbounded minutes', () => {
    expect(formatRemaining(T, T - 125_000)).toBe('2:05');
    expect(formatRemaining(T, T - 59_000)).toBe('0:59');
    expect(formatRemaining(T, T - 90 * 60_000)).toBe('90:00');
  });

  it('rounds a partial second up, so 0:00 only shows once the deadline has come', () => {
    expect(formatRemaining(T, T - 1)).toBe('0:01');
    expect(formatRemaining(T, T - 1_500)).toBe('0:02');
    expect(remainingSeconds(T, T - 1)).toBe(1);
  });

  it('formatRemaining floors at 0:00', () => {
    expect(formatRemaining(T, T)).toBe('0:00');
    expect(formatRemaining(T, T + 1)).toBe('0:00');
    // A laptop that slept two hours past the deadline never shows negative time.
    expect(formatRemaining(T, T + 2 * 60 * 60 * 1000)).toBe('0:00');
    expect(remainingSeconds(T, T + 5_000)).toBe(0);
    // Garbage in is never shown as a countdown.
    expect(formatRemaining(Number.NaN, T)).toBe('0:00');
    expect(formatRemaining(T, Number.NaN)).toBe('0:00');
    expect(formatRemaining(Number.POSITIVE_INFINITY, T)).toBe('0:00');
  });
});
