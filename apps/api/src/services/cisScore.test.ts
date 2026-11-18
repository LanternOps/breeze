import { describe, it, expect } from 'vitest';
import { averageCisScore, cisDeviceScore } from './cisScore';

describe('averageCisScore (#9606 — one definition for the page and the posture report)', () => {
  it('rounds the mean of the stored per-device scores', () => {
    expect(averageCisScore([79, 80, 79])).toBe(79);
    expect(averageCisScore([79, 80])).toBe(80); // 79.5 rounds up
  });

  it('returns null when nothing was scanned', () => {
    expect(averageCisScore([])).toBeNull();
  });
});

describe('cisDeviceScore — never NaN', () => {
  it('uses the stored numeric score when present', () => {
    expect(cisDeviceScore({ score: 83, passedChecks: 1, totalChecks: 2 })).toBe(83);
  });

  it('derives from passed/total (rounded once) when the stored score is missing or non-numeric', () => {
    expect(cisDeviceScore({ passedChecks: 80, totalChecks: 100 })).toBe(80);
    expect(cisDeviceScore({ score: undefined, passedChecks: 2, totalChecks: 3 })).toBe(67);
    expect(cisDeviceScore({ score: null, passedChecks: 1, totalChecks: 8 })).toBe(13); // 12.5 rounds up
    expect(cisDeviceScore({ score: Number.NaN, passedChecks: 60, totalChecks: 100 })).toBe(60);
  });

  it('is null (not assessed) when nothing was evaluated', () => {
    expect(cisDeviceScore({ score: 100, passedChecks: 0, totalChecks: 0 })).toBeNull();
    expect(cisDeviceScore({ passedChecks: 0, totalChecks: 0 })).toBeNull();
  });
});
