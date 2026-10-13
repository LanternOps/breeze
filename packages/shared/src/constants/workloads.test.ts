import { describe, expect, it } from 'vitest';
import {
  compliancePercentWithImageTerm,
  hasImageComplianceTerm,
  WORKLOAD_UPSTREAM_STATUSES,
  WORKLOAD_UPSTREAM_UNKNOWN_STATUSES,
  workloadUpstreamStatusClass,
} from './workloads';

describe('upstream status classes (spec §9.1 / §10.1)', () => {
  it('classifies every status exactly once', () => {
    const classes = Object.fromEntries(WORKLOAD_UPSTREAM_STATUSES.map((s) => [s, workloadUpstreamStatusClass(s)]));
    expect(classes).toEqual({
      pending: 'unknown',
      current: 'current',
      behind: 'stale',
      pinned: 'not_applicable',
      local: 'not_applicable',
      private: 'unknown',
      unsupported_registry: 'unknown',
      not_found: 'not_applicable',
      error: 'unknown',
    });
    expect([...WORKLOAD_UPSTREAM_UNKNOWN_STATUSES].sort()).toEqual(
      ['error', 'pending', 'private', 'unsupported_registry'],
    );
  });
});

describe('compliancePercentWithImageTerm', () => {
  it('is the plain installed/total ratio when there is no image term', () => {
    for (const [installed, total] of [[0, 0], [3, 4], [1, 3], [2, 3], [7, 7], [0, 5]] as const) {
      const plain = total > 0 ? Math.round((installed / total) * 100) : 100;
      expect(compliancePercentWithImageTerm(installed, total, null)).toBe(plain);
      expect(compliancePercentWithImageTerm(installed, total, undefined)).toBe(plain);
      expect(compliancePercentWithImageTerm(installed, total, { stale: 0, current: 0, unknown: 0 })).toBe(plain);
    }
  });

  it('counts a stale image as a pending item and a current image as an installed item', () => {
    // 3 installed of 4 OS items, plus 2 stale + 1 current images → (3+1)/(4+3)
    expect(compliancePercentWithImageTerm(3, 4, { stale: 2, current: 1, unknown: 0 })).toBe(57);
    // no OS items at all: images alone decide
    expect(compliancePercentWithImageTerm(0, 0, { stale: 1, current: 1, unknown: 0 })).toBe(50);
  });

  it('never lets unknown images enter the denominator', () => {
    expect(compliancePercentWithImageTerm(3, 4, { stale: 0, current: 0, unknown: 9 })).toBe(75);
    expect(compliancePercentWithImageTerm(0, 0, { stale: 0, current: 0, unknown: 9 })).toBe(100);
  });

  it('never lets unknown images mask a known OS breach', () => {
    expect(compliancePercentWithImageTerm(0, 10, { stale: 0, current: 0, unknown: 50 })).toBe(0);
  });
});

describe('hasImageComplianceTerm', () => {
  it('is false for null and all-zero terms', () => {
    expect(hasImageComplianceTerm(null)).toBe(false);
    expect(hasImageComplianceTerm({ stale: 0, current: 0, unknown: 0 })).toBe(false);
    expect(hasImageComplianceTerm({ stale: 0, current: 0, unknown: 1 })).toBe(true);
  });
});
