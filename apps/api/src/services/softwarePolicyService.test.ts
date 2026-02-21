import { describe, expect, it } from 'vitest';
import {
  compareSoftwareVersions,
  evaluateSoftwareInventory,
  matchesSoftwareRule,
  normalizeSoftwarePolicyRules,
  withStableViolationTimestamps,
} from './softwarePolicyService';

describe('softwarePolicyService', () => {
  it('compares semantic-like versions correctly', () => {
    expect(compareSoftwareVersions('121.0.6167.161', '120.9.9999.1')).toBeGreaterThan(0);
    expect(compareSoftwareVersions('1.2.0', '1.2')).toBe(0);
    expect(compareSoftwareVersions('2.0-beta', '2.0-alpha')).toBeGreaterThan(0);
  });

  it('matches software rules with wildcards, vendor, and version bounds', () => {
    const installed = {
      name: 'Google Chrome Enterprise',
      version: '121.0.6167.161',
      vendor: 'Google',
      catalogId: null,
    };

    expect(matchesSoftwareRule(installed, {
      name: 'Google Chrome*',
      vendor: 'Google',
      minVersion: '120.0',
      maxVersion: '121.9',
    })).toBe(true);

    expect(matchesSoftwareRule(installed, {
      name: 'Google Chrome*',
      vendor: 'Mozilla',
    })).toBe(false);
  });

  it('evaluates allowlist policies with missing and unauthorized violations', () => {
    const rules = normalizeSoftwarePolicyRules({
      software: [
        { name: 'Google Chrome*' },
        { name: '7-Zip', minVersion: '23.0' },
      ],
      allowUnknown: false,
    });

    const violations = evaluateSoftwareInventory('allowlist', rules, [
      { name: 'Google Chrome', version: '121.0', vendor: 'Google', catalogId: null },
      { name: 'VLC Media Player', version: '3.0.20', vendor: 'VideoLAN', catalogId: null },
    ]);

    expect(violations.some((violation) => violation.type === 'unauthorized' && violation.software?.name === 'VLC Media Player')).toBe(true);
    expect(violations.some((violation) => violation.type === 'missing' && violation.rule?.name === '7-Zip')).toBe(true);
  });

  it('evaluates blocklist policies as unauthorized violations', () => {
    const rules = normalizeSoftwarePolicyRules({
      software: [{ name: 'TeamViewer*', reason: 'Unapproved remote access tooling' }],
    });

    const violations = evaluateSoftwareInventory('blocklist', rules, [
      { name: 'TeamViewer Host', version: '15.2', vendor: 'TeamViewer', catalogId: null },
      { name: 'Google Chrome', version: '121.0', vendor: 'Google', catalogId: null },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.type).toBe('unauthorized');
    expect(violations[0]?.rule?.reason).toBe('Unapproved remote access tooling');
  });

  it('preserves detectedAt timestamps for repeated violations', () => {
    const previousDetectedAt = '2026-01-01T10:00:00.000Z';
    const previousViolations = [{
      type: 'unauthorized',
      software: { name: 'TeamViewer Host', version: '15.2' },
      severity: 'critical',
      detectedAt: previousDetectedAt,
    }];

    const nextViolations = [{
      type: 'unauthorized',
      software: { name: 'TeamViewer Host', version: '15.2' },
      severity: 'critical',
      detectedAt: '2026-02-01T10:00:00.000Z',
    }];

    const stabilized = withStableViolationTimestamps(nextViolations, previousViolations);
    expect(stabilized[0]?.detectedAt).toBe(previousDetectedAt);
  });

  it('drops rules without a name field from normalization', () => {
    const rules = normalizeSoftwarePolicyRules({
      software: [
        { name: 'Google Chrome' },
        { vendor: 'Adobe' },
        { name: '' },
        { name: '   ' },
      ],
    });

    expect(rules.software).toHaveLength(1);
    expect(rules.software[0]?.name).toBe('Google Chrome');
  });

  it('treats allowUnknown: false as default when not provided', () => {
    const rules = normalizeSoftwarePolicyRules({ software: [{ name: 'Chrome' }] });
    expect(rules.allowUnknown).toBe(false);
  });

  it('allowUnknown: true skips unauthorized violations for unknowns in allowlist mode', () => {
    const rules = normalizeSoftwarePolicyRules({
      software: [{ name: 'Google Chrome*' }],
      allowUnknown: true,
    });

    const violations = evaluateSoftwareInventory('allowlist', rules, [
      { name: 'TeamViewer Host', version: '15.2', vendor: null, catalogId: null },
    ]);

    expect(violations.filter((v) => v.type === 'unauthorized')).toHaveLength(0);
  });

  it('audit mode produces medium severity violations', () => {
    const rules = normalizeSoftwarePolicyRules({
      software: [{ name: 'TeamViewer*', reason: 'Unapproved' }],
    });

    const violations = evaluateSoftwareInventory('audit', rules, [
      { name: 'TeamViewer Host', version: '15.2', vendor: 'TeamViewer', catalogId: null },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe('medium');
  });

  it('blocklist mode produces critical severity violations', () => {
    const rules = normalizeSoftwarePolicyRules({
      software: [{ name: 'TeamViewer*' }],
    });

    const violations = evaluateSoftwareInventory('blocklist', rules, [
      { name: 'TeamViewer Host', version: '15.2', vendor: 'TeamViewer', catalogId: null },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe('critical');
  });
});

describe('evaluateSoftwareInventory audit mode', () => {
  it('produces unauthorized violations with medium severity', () => {
    const rules = normalizeSoftwarePolicyRules({ software: [{ name: 'Slack', reason: 'Audit only' }] });
    const inventory = [{ name: 'Slack', version: '4.0.0', vendor: null, catalogId: null }];
    const result = evaluateSoftwareInventory('audit', rules, inventory);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('unauthorized');
    expect(result[0].severity).toBe('medium');
  });

  it('does not produce missing violations in audit mode', () => {
    const rules = normalizeSoftwarePolicyRules({ software: [{ name: 'RequiredApp' }] });
    const result = evaluateSoftwareInventory('audit', rules, []);
    expect(result).toHaveLength(0);
  });
});

describe('compareSoftwareVersions edge cases', () => {
  it('returns 0 for identical versions', () => {
    expect(compareSoftwareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('correctly orders 10.x as greater than 9.x', () => {
    expect(compareSoftwareVersions('10.0', '9.9')).toBeGreaterThan(0);
    expect(compareSoftwareVersions('9.9', '10.0')).toBeLessThan(0);
  });

  it('handles empty string inputs', () => {
    expect(compareSoftwareVersions('', '')).toBe(0);
  });
});
