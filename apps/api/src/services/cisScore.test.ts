import { describe, it, expect } from 'vitest';
import { averageCisScore } from './cisScore';

describe('averageCisScore (#9606 — one definition for the page and the posture report)', () => {
  it('rounds the mean of the stored per-device scores', () => {
    expect(averageCisScore([79, 80, 79])).toBe(79);
    expect(averageCisScore([79, 80])).toBe(80); // 79.5 rounds up
  });

  it('returns null when nothing was scanned', () => {
    expect(averageCisScore([])).toBeNull();
  });
});
