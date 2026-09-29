import { expect, it } from 'vitest';
import { isTimeStatusStale } from './freshness';
it('is fresh exactly at 90 minutes and stale one millisecond later', () => {
  const received = new Date('2026-09-28T00:00:00Z');
  expect(isTimeStatusStale(received, new Date(+received + 5_400_000))).toBe(
    false,
  );
  expect(isTimeStatusStale(received, new Date(+received + 5_400_001))).toBe(
    true,
  );
});
