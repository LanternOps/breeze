import { describe, expect, it } from 'vitest';
import { imageTermAppliesToView, sumContainerImageTerms } from './imageCompliance';

describe('imageTermAppliesToView', () => {
  it('applies only to an unfiltered view', () => {
    expect(imageTermAppliesToView({})).toBe(true);
    expect(imageTermAppliesToView({ severity: null, source: null, ringId: null })).toBe(true);
  });

  it.each([
    ['severity', { severity: 'critical' }],
    ['source', { source: 'microsoft' }],
    ['update ring', { ringId: '66666666-6666-4666-8666-666666666666' }],
  ])('is excluded from a %s-filtered view', (_name, filters) => {
    expect(imageTermAppliesToView(filters)).toBe(false);
  });
});

describe('sumContainerImageTerms', () => {
  it('is null when no device has anything to count', () => {
    expect(sumContainerImageTerms([])).toBeNull();
  });

  it('adds each count across devices', () => {
    expect(sumContainerImageTerms([
      { stale: 1, current: 0, unknown: 2 },
      { stale: 1, current: 2, unknown: 0 },
    ])).toEqual({ stale: 2, current: 2, unknown: 2 });
  });
});
