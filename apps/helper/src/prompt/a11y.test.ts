import { describe, expect, it } from 'vitest';

import { shouldAnnounce } from './a11y';

describe('a11y', () => {
  it('shouldAnnounce only at 60/30/10', () => {
    // Crossing each threshold from above announces once.
    expect(shouldAnnounce(61, 60)).toBe(true);
    expect(shouldAnnounce(31, 30)).toBe(true);
    expect(shouldAnnounce(11, 10)).toBe(true);
    // Ticking anywhere else is silent: a ticking live region interrupts reading.
    for (const [prev, now] of [
      [62, 61],
      [60, 59],
      [59, 58],
      [45, 44],
      [30, 29],
      [10, 9],
      [9, 8],
      [1, 0],
      [0, 0],
      [120, 119],
    ] as const) {
      expect(shouldAnnounce(prev, now), `${prev} -> ${now}`).toBe(false);
    }
    // A skipped tick (busy main thread, sleep) still announces the crossing, once.
    expect(shouldAnnounce(62, 58)).toBe(true);
    expect(shouldAnnounce(40, 5)).toBe(true);
    // No previous reading, or the clock moving backwards: silent.
    expect(shouldAnnounce(null, 60)).toBe(false);
    expect(shouldAnnounce(30, 61)).toBe(false);
    expect(shouldAnnounce(60, 60)).toBe(false);
  });
});
