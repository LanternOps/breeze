import { describe, expect, it } from 'vitest';
import {
  assessDiffRisk,
  buildRedactedUnifiedDiff,
  evaluateFirmwarePosture,
  hashConfig,
  normalizeConfig
} from './networkConfigManagement';

describe('networkConfigManagement helpers', () => {
  it('normalizes line endings and trims trailing whitespace', () => {
    const normalized = normalizeConfig('hostname sw1  \r\ninterface Gi0/1\r\n no shutdown  \r\n');
    expect(normalized).toBe('hostname sw1\ninterface Gi0/1\n no shutdown');
  });

  it('hashes equivalent configs consistently', () => {
    const a = hashConfig(normalizeConfig('hostname sw1\r\ninterface Gi0/1'));
    const b = hashConfig(normalizeConfig('hostname sw1\ninterface Gi0/1'));
    expect(a).toBe(b);
  });

  it('redacts obvious secret values from rendered diff output', () => {
    const previousConfig = `
hostname edge-1
username admin password oldSecret
snmp-server community private rw
`;
    const currentConfig = `
hostname edge-1
username admin password newSecret
snmp-server community private rw
`;

    const { diff } = buildRedactedUnifiedDiff(previousConfig, currentConfig);
    expect(diff).not.toContain('oldSecret');
    expect(diff).not.toContain('newSecret');
    expect(diff).toContain('<redacted>');
  });

  it('classifies high-risk deltas when dangerous controls are introduced', () => {
    const assessment = assessDiffRisk(
      [
        'transport input telnet',
        'permit ip any any'
      ],
      []
    );

    expect(['high', 'critical']).toContain(assessment.riskLevel);
    expect(assessment.summary).toContain('line(s) added');
    expect(assessment.matchedSignals.length).toBeGreaterThan(0);
  });

  it('truncates to summary mode for very large configs', () => {
    const previousConfig = Array.from({ length: 4_100 }, (_, i) => `line-${i}`).join('\n');
    const currentConfig = `${previousConfig}\ntransport input telnet`;
    const result = buildRedactedUnifiedDiff(previousConfig, currentConfig);

    expect(result.truncated).toBe(true);
    expect(result.diff).toContain('large-config-summary');
    expect(result.addedLines.length).toBeGreaterThan(0);
  });

  it('evaluates firmware posture with semantic version comparison', () => {
    const posture = evaluateFirmwarePosture({
      currentVersion: '1.10.0',
      latestVersion: '1.2.0',
      cveCount: 0,
      eolDate: null,
      now: Date.now()
    });

    expect(posture.isBehind).toBe(false);
    expect(posture.vulnerable).toBe(false);
  });
});
