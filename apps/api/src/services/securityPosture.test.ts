import { describe, expect, it } from 'vitest';

import { computeTrendPoint, scoreEncryption } from './securityPosture';

function deviceInputWithEncryption(encryptionStatus: string | null, encryptionDetails: unknown = null) {
  return {
    orgId: 'org-1',
    deviceId: 'dev-1',
    deviceName: 'host-1',
    osType: 'windows' as const,
    deviceStatus: 'online' as const,
    osVersion: '10.0.19045',
    security: {
      realTimeProtection: true,
      definitionsDate: null,
      threatCount: 0,
      firewallEnabled: true,
      encryptionStatus,
      encryptionDetails,
      localAdminSummary: null,
      passwordPolicySummary: null
    },
    patchStats: { totalCriticalAndImportant: 0, installedCriticalAndImportant: 0 },
    activeThreats: 0,
    portStats: { listeningPortCount: 0, riskyPortCount: 0 }
  };
}

describe('scoreEncryption', () => {
  // Regression for #1831: 'encrypted' is a substring of 'unencrypted', so the
  // original substring-order classified unencrypted devices as encrypted and
  // scored them 100 in the posture score. An unencrypted device must score 0.
  it('scores an unencrypted device 0, not 100', () => {
    const result = scoreEncryption(deviceInputWithEncryption('unencrypted') as never);
    expect(result.score).toBe(0);
    expect(result.evidence?.encryptionStatus).toBe('unencrypted');
  });

  it('still scores an encrypted device 100', () => {
    const result = scoreEncryption(deviceInputWithEncryption('encrypted') as never);
    expect(result.score).toBe(100);
  });

  it('scores a partially encrypted device 60', () => {
    const result = scoreEncryption(deviceInputWithEncryption('partial') as never);
    expect(result.score).toBe(60);
  });

  it('treats off/disabled as unencrypted (score 0)', () => {
    expect(scoreEncryption(deviceInputWithEncryption('off') as never).score).toBe(0);
    expect(scoreEncryption(deviceInputWithEncryption('disabled') as never).score).toBe(0);
  });

  it('classifies mixed-case unencrypted as unencrypted (score 0)', () => {
    expect(scoreEncryption(deviceInputWithEncryption('Unencrypted') as never).score).toBe(0);
  });

  // "unknown" must stay distinct from "unencrypted": it is a low-confidence
  // data gap (score 50), not a definite 0. Guards against a fail-safe
  // overcorrection that collapses unknown -> 0 (or -> 100).
  it('treats unknown/missing status as a 50-score data gap, not 0 or 100', () => {
    for (const status of ['unknown', '', null] as const) {
      const result = scoreEncryption(deviceInputWithEncryption(status) as never);
      expect(result.score).toBe(50);
      expect(result.dataGap).toBeTruthy();
    }
  });

  it('prefers volume coverage over the status string when details are present', () => {
    const result = scoreEncryption(
      deviceInputWithEncryption('unencrypted', { volumes: [{ protected: true }, { protected: true }] }) as never
    );
    expect(result.score).toBe(100);
  });
});

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
