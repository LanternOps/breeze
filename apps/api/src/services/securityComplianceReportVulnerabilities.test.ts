import { describe, expect, it } from 'vitest';

import { aggregateVulnerabilityCounts } from './securityComplianceReportVulnerabilities';

describe('aggregateVulnerabilityCounts', () => {
  it('normalizes source severity casing and counts findings per device', () => {
    const counts = aggregateVulnerabilityCounts(
      [
        { deviceId: 'd1', vulnerabilityId: 'v1' },
        { deviceId: 'd1', vulnerabilityId: 'v2' },
        { deviceId: 'd2', vulnerabilityId: 'v3' },
        { deviceId: 'd2', vulnerabilityId: 'v4' },
      ],
      [
        { id: 'v1', severity: 'HIGH' },
        { id: 'v2', severity: 'Critical' },
        { id: 'v3', severity: 'High' },
        { id: 'v4', severity: 'CRITICAL' },
      ],
    );

    expect(counts.get('d1')).toEqual({ high: 1, critical: 1 });
    expect(counts.get('d2')).toEqual({ high: 1, critical: 1 });
  });

  it('fails instead of publishing zeroes when referenced catalog rows are missing', () => {
    expect(() =>
      aggregateVulnerabilityCounts(
        [{ deviceId: 'd1', vulnerabilityId: 'missing' }],
        [],
      ),
    ).toThrow('Vulnerability catalog lookup incomplete');
  });
});
