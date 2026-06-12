import { describe, it, expect } from 'vitest';
import {
  PRIORITY_SLA_DEFAULTS,
  SLA_AT_RISK_RATIO,
  resolveSlaTargets,
  breachedTargets,
  appendBreachTarget
} from './ticketSla';

describe('PRIORITY_SLA_DEFAULTS', () => {
  it('tracks urgent and high only (D5)', () => {
    expect(PRIORITY_SLA_DEFAULTS.urgent).toEqual({ responseMinutes: 60, resolutionMinutes: 240 });
    expect(PRIORITY_SLA_DEFAULTS.high).toEqual({ responseMinutes: 240, resolutionMinutes: 1440 });
    expect(PRIORITY_SLA_DEFAULTS.normal).toEqual({ responseMinutes: null, resolutionMinutes: null });
    expect(PRIORITY_SLA_DEFAULTS.low).toEqual({ responseMinutes: null, resolutionMinutes: null });
  });
});

describe('resolveSlaTargets', () => {
  const cases: Array<{ name: string; input: Parameters<typeof resolveSlaTargets>[0]; expected: { responseMinutes: number | null; resolutionMinutes: number | null } }> = [
    { name: 'override wins over category and priority',
      input: { overrideResponseMinutes: 5, overrideResolutionMinutes: 10, categoryResponseMinutes: 30, categoryResolutionMinutes: 60, priority: 'urgent' },
      expected: { responseMinutes: 5, resolutionMinutes: 10 } },
    { name: 'category wins over priority',
      input: { categoryResponseMinutes: 30, categoryResolutionMinutes: 60, priority: 'urgent' },
      expected: { responseMinutes: 30, resolutionMinutes: 60 } },
    { name: 'priority default fallback for urgent',
      input: { priority: 'urgent' },
      expected: { responseMinutes: 60, resolutionMinutes: 240 } },
    { name: 'normal priority with no category yields no SLA',
      input: { priority: 'normal' },
      expected: { responseMinutes: null, resolutionMinutes: null } },
    { name: 'per-target independence: category sets resolution only, response falls to priority',
      input: { categoryResolutionMinutes: 90, priority: 'high' },
      expected: { responseMinutes: 240, resolutionMinutes: 90 } }
  ];
  for (const c of cases) {
    it(c.name, () => expect(resolveSlaTargets(c.input)).toEqual(c.expected));
  }
});

describe('breachedTargets / appendBreachTarget', () => {
  it('parses null/empty as no targets', () => {
    expect(breachedTargets(null).size).toBe(0);
    expect(breachedTargets('').size).toBe(0);
  });
  it('parses CSV and ignores unknown entries', () => {
    expect([...breachedTargets('response')]).toEqual(['response']);
    expect([...breachedTargets('response,resolution')].sort()).toEqual(['resolution', 'response'].sort());
    expect([...breachedTargets('response,bogus')]).toEqual(['response']);
  });
  it('appends without duplicating', () => {
    expect(appendBreachTarget(null, 'response')).toBe('response');
    expect(appendBreachTarget('response', 'resolution')).toBe('response,resolution');
    expect(appendBreachTarget('response', 'response')).toBe('response');
  });
  it('does not confuse response with resolution substrings', () => {
    expect(breachedTargets('resolution').has('response')).toBe(false);
  });
});

describe('SLA_AT_RISK_RATIO', () => {
  it('is 80% per spec §3', () => expect(SLA_AT_RISK_RATIO).toBe(0.8));
});
