import { describe, expect, it } from 'vitest';
import { emptyTicketSlaPerformanceSummary, isTicketSlaPerformanceSummary } from './ticketSlaPerformance';

describe('emptyTicketSlaPerformanceSummary', () => {
  it('empty summary has four zero priority rows urgent→low and null ratios', () => {
    const s = emptyTicketSlaPerformanceSummary('not measured');
    expect(s.priorities.map((r) => r.priority)).toEqual(['urgent', 'high', 'normal', 'low']);
    expect(s.rows).toBe(s.priorities);
    expect(s.overall.priority).toBe('all');
    for (const r of [...s.priorities, s.overall]) {
      expect(r.ticketsOpened).toBe(0);
      expect(r.responseMeasured).toBe(0);
      expect(r.responseAttainment).toBeNull();
      expect(r.resolutionAttainment).toBeNull();
      expect(r.responseMedianMinutes).toBeNull();
      expect(r.resolutionMeanMinutes).toBeNull();
      expect(r.responseTargetMinutes).toBeNull();
      expect(r.responseTargetVaries).toBe(false);
    }
    expect(s.notes).toEqual(['not measured']);
    expect(s.includeSubjects).toBe(false);
    expect(s.breaches).toEqual({ cap: 1000, stored: 0, available: 0, truncated: false, rows: [] });
  });

  // The site-restricted artifact must keep the designed renderer, because that
  // is what prints "not measured"; the generic table would read as real zeros.
  it('the empty summary is accepted by the shape guard', () => {
    expect(isTicketSlaPerformanceSummary(emptyTicketSlaPerformanceSummary('x'))).toBe(true);
  });
});

describe('isTicketSlaPerformanceSummary', () => {
  const good = () => emptyTicketSlaPerformanceSummary('x');

  it('isTicketSlaPerformanceSummary rejects period: null and a missing breaches block', () => {
    expect(isTicketSlaPerformanceSummary({ ...good(), period: null })).toBe(false);
    const { breaches: _breaches, ...withoutBreaches } = good();
    expect(isTicketSlaPerformanceSummary(withoutBreaches)).toBe(false);
  });

  it('rejects non-objects, a missing priorities array and non-array breach rows', () => {
    for (const v of [null, undefined, 'x', 1, []]) expect(isTicketSlaPerformanceSummary(v)).toBe(false);
    expect(isTicketSlaPerformanceSummary({ ...good(), priorities: undefined })).toBe(false);
    expect(isTicketSlaPerformanceSummary({ ...good(), breaches: { rows: 'x' } })).toBe(false);
    expect(isTicketSlaPerformanceSummary({ ...good(), overall: null })).toBe(false);
  });
});
