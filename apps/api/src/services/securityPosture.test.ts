import { describe, expect, it } from 'vitest';

import { computeTrendPoint } from './securityPosture';

describe('computeTrendPoint', () => {
  it('derives vulnerability_management from open_ports and os_currency averages', () => {
    const point = computeTrendPoint('2026-02-22', [
      {
        overallScore: 70,
        patchComplianceScore: 72,
        encryptionScore: 80,
        avHealthScore: 78,
        firewallScore: 76,
        openPortsScore: 50,
        passwordPolicyScore: 74,
        osCurrencyScore: 80,
        adminExposureScore: 75
      },
      {
        overallScore: 74,
        patchComplianceScore: 76,
        encryptionScore: 82,
        avHealthScore: 80,
        firewallScore: 78,
        openPortsScore: 70,
        passwordPolicyScore: 78,
        osCurrencyScore: 60,
        adminExposureScore: 77
      }
    ]);

    expect(point.open_ports).toBe(60);
    expect(point.os_currency).toBe(70);
    expect(point.vulnerability_management).toBe(65);
  });

  it('returns zeroed factors for empty input', () => {
    const point = computeTrendPoint('2026-02-22', []);

    expect(point.timestamp).toBe('2026-02-22');
    expect(point.overall).toBe(0);
    expect(point.open_ports).toBe(0);
    expect(point.os_currency).toBe(0);
    expect(point.vulnerability_management).toBe(0);
  });
});
