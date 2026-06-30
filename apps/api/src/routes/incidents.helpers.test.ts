import { describe, it, expect } from 'vitest';
import { severityRankToLabel } from './incidents.helpers';

describe('severityRankToLabel', () => {
  it('maps rank 1..4 to p1..p4 and clamps unknown to p3', () => {
    expect(severityRankToLabel(1)).toBe('p1');
    expect(severityRankToLabel(2)).toBe('p2');
    expect(severityRankToLabel(3)).toBe('p3');
    expect(severityRankToLabel(4)).toBe('p4');
    expect(severityRankToLabel(99)).toBe('p3');
  });
});
