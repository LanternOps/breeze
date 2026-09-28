import { describe, expect, it, vi } from 'vitest';
import { parseRetryAfterMs } from './retryAfter';

describe('parseRetryAfterMs', () => {
  it.each([
    [null, null],
    ['', null],
    ['30', 30_000],
    ['0', 0],
    ['1.5', 1_500],
    ['-5', null],
    ['soon', null],
  ])('%j -> %j', (header, expected) => {
    expect(parseRetryAfterMs(header)).toBe(expected);
  });

  it('reads an HTTP-date as the wait until then, clamping a past date to 0', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-26T12:00:00.000Z'));
      expect(parseRetryAfterMs('Sat, 26 Sep 2026 12:00:45 GMT')).toBe(45_000);
      expect(parseRetryAfterMs('Sat, 26 Sep 2026 11:00:00 GMT')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
