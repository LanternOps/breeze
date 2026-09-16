import { describe, expect, it } from 'vitest';
import {
  complianceBreakdown, freshnessLine, isStaleSnapshot, trendDelta,
} from './endpointManagement';

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

describe('complianceBreakdown', () => {
  it('returns null when the domain was not measured — unmeasured, not all-zero', () => {
    expect(complianceBreakdown([], false)).toBeNull();
    // Even with rows in hand: unmeasured wins, because those rows cannot be a
    // complete population.
    expect(complianceBreakdown([{ complianceState: 'compliant' }] as never, false)).toBeNull();
  });

  it('returns a truthful all-zero record for a MEASURED but empty population', () => {
    // The distinction the explicit flag exists for. Returning null here made
    // the artifact print "not measured" about a domain that had synced fine and
    // simply had no devices in the reader's scope.
    expect(complianceBreakdown([], true)).toEqual({
      compliant: 0, noncompliant: 0, inGracePeriod: 0, unknown: 0,
    });
  });

  it('buckets an unrecognised compliance_state as unknown, never as compliant', () => {
    const got = complianceBreakdown([
      { complianceState: 'configManager' },
      { complianceState: null },
    ] as never, true);
    expect(got).toEqual({ compliant: 0, noncompliant: 0, inGracePeriod: 0, unknown: 2 });
  });

  it('counts the four known states', () => {
    const got = complianceBreakdown([
      { complianceState: 'compliant' },
      { complianceState: 'compliant' },
      { complianceState: 'noncompliant' },
      { complianceState: 'inGracePeriod' },
    ] as never, true);
    expect(got).toEqual({ compliant: 2, noncompliant: 1, inGracePeriod: 1, unknown: 0 });
  });
});

describe('isStaleSnapshot', () => {
  it('treats an absent snapshot as stale — never-measured is not fresh', () => {
    expect(isStaleSnapshot(null, 6)).toBe(true);
    expect(isStaleSnapshot(undefined, 6)).toBe(true);
  });

  it('treats an unparseable timestamp as stale rather than silently fresh', () => {
    expect(isStaleSnapshot('not-a-date', 6)).toBe(true);
  });

  it('is fresh inside the cadence grace and stale beyond it', () => {
    expect(isStaleSnapshot(hoursAgo(6), 6)).toBe(false);
    expect(isStaleSnapshot(hoursAgo(17), 6)).toBe(false);
    expect(isStaleSnapshot(hoursAgo(19), 6)).toBe(true);
  });

  it('agrees with freshnessLine on the same input', () => {
    expect(isStaleSnapshot(hoursAgo(24 * 29), 6)).toBe(true);
    expect(freshnessLine({ asOf: hoursAgo(24 * 29), lastStatus: 'success' }, 6)).toMatch(/stale/i);
  });
});

describe('trendDelta', () => {
  it('is null for a series too short to have a delta', () => {
    expect(trendDelta([])).toBeNull();
    expect(trendDelta([{ date: '2026-09-01', compliant: 5, noncompliant: 0, inGrace: 0, unknown: 0 }])).toBeNull();
  });

  it('is null when either endpoint is unmeasured, rather than treating null as zero', () => {
    expect(trendDelta([
      { date: '2026-09-01', compliant: null, noncompliant: 0, inGrace: 0, unknown: 0 },
      { date: '2026-09-02', compliant: 9, noncompliant: 0, inGrace: 0, unknown: 0 },
    ])).toBeNull();
  });

  it('takes last minus first on the compliant series', () => {
    expect(trendDelta([
      { date: '2026-09-01', compliant: 40, noncompliant: 3, inGrace: 0, unknown: 0 },
      { date: '2026-09-15', compliant: 44, noncompliant: 1, inGrace: 0, unknown: 0 },
    ])).toBe(4);
  });
});

describe('freshnessLine', () => {
  it('is empty when the snapshot is inside the cadence', () => {
    expect(freshnessLine({ asOf: hoursAgo(3), lastStatus: 'success' }, 6)).toBe('');
  });

  it('calls a 29-day-old snapshot stale even inside a monthly period', () => {
    const line = freshnessLine({ asOf: hoursAgo(24 * 29), lastStatus: 'success' }, 6);
    expect(line).toMatch(/stale/i);
  });

  it('names needs_consent rather than reporting zeros', () => {
    const line = freshnessLine({ asOf: null, sources: { managedDevices: 'needs_consent' } }, 6);
    expect(line).toMatch(/consent/i);
    expect(line).not.toMatch(/\b0 devices\b/);
  });

  it('names a throttled source', () => {
    expect(freshnessLine({ asOf: hoursAgo(1), sources: { managedDevices: 'throttled' } }, 6))
      .toMatch(/throttl/i);
  });

  it('says "never completed" when the domain has no complete snapshot at all', () => {
    expect(freshnessLine({ asOf: null, lastStatus: null }, 6)).toMatch(/never completed/i);
  });

  it('reports a truncated enumeration', () => {
    expect(freshnessLine({ asOf: hoursAgo(1), lastStatus: 'success', truncated: true }, 6))
      .toMatch(/truncat/i);
  });
});
