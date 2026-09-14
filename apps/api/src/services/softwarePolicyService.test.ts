import { describe, expect, it } from 'vitest';
import {
  SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS,
  compareSoftwareVersions,
  evaluateSoftwareInventory,
  matchesSoftwareRule,
  normalizeSoftwarePolicyRules,
  withStableViolationTimestamps,
} from './softwarePolicyService';
import type { SoftwarePolicyViolation } from '../db/schema';

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
    const previousViolations: SoftwarePolicyViolation[] = [{
      type: 'unauthorized',
      software: { name: 'TeamViewer Host', version: '15.2' },
      severity: 'critical',
      detectedAt: previousDetectedAt,
    }];

    const nextViolations: SoftwarePolicyViolation[] = [{
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
    expect(result[0]?.type).toBe('unauthorized');
    expect(result[0]?.severity).toBe('medium');
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

/**
 * #5505 D6 — `software_policy_audit.action` is a bare varchar(50) with no enum
 * and no pre-existing const set (softwarePolicies.ts:142), so this object IS
 * the registry. An audit reader must never have to infer the verb, so install
 * events never reuse an uninstall action value.
 */
describe('SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS', () => {
  // Every action string already written to software_policy_audit.action,
  // enumerated from the emitters as of #5506. The point is collision, not
  // completeness: a new install action must not be any of these.
  const EXISTING_ACTIONS = [
    'policy_created',
    'policy_updated',
    'policy_deleted',
    'compliance_check_requested',
    'compliance_check_failed',
    'violation_detected',
    'remediation_requested',
    'remediation_scheduled',
    'remediation_denied',
    'remediation_deferred',
    'remediation_skipped_unarmed',
    'remediation_manual_override',
    'remediation_command_failed',
    'software_uninstalled',
    'inventory_approve',
    'inventory_deny',
    'inventory_clear',
  ];

  it('exposes exactly the four install actions the contract names', () => {
    expect(SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS).toEqual({
      queued: 'install_queued',
      succeeded: 'install_succeeded',
      failed: 'install_failed',
      gaveUp: 'install_gave_up',
    });
  });

  it('never collides with an existing uninstall or lifecycle action', () => {
    for (const action of Object.values(SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS)) {
      expect(EXISTING_ACTIONS).not.toContain(action);
    }
  });

  it('every value is install-prefixed and fits software_policy_audit.action varchar(50)', () => {
    for (const action of Object.values(SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS)) {
      expect(action.startsWith('install_')).toBe(true);
      expect(action.length).toBeLessThanOrEqual(50);
    }
  });
});

/**
 * #5505 D9 — a `missing` violation is the ONLY place the install path can
 * learn WHAT to install. Before this wave the emission dropped the rule's
 * `catalogId`, and re-matching a violation to its rule by name is not an
 * option: rule names are not unique within a policy and nothing enforces that
 * they are.
 */
describe('missing violations carry the rule catalogId', () => {
  const CATALOG_ID = '99999999-9999-4999-8999-999999999999';

  it('emits catalogId and reason from the unmatched rule', () => {
    const rules = normalizeSoftwarePolicyRules({
      software: [{ name: '7-Zip', minVersion: '23.0', catalogId: CATALOG_ID, reason: 'Standard archive tool' }],
      allowUnknown: true,
    });

    const violations = evaluateSoftwareInventory('allowlist', rules, []);
    const missing = violations.find((v) => v.type === 'missing');

    expect(missing).toBeDefined();
    expect(missing?.rule).toEqual({
      name: '7-Zip',
      minVersion: '23.0',
      maxVersion: undefined,
      catalogId: CATALOG_ID,
      reason: 'Standard archive tool',
    });
  });

  it('leaves catalogId undefined for a rule that has none — never fabricates one', () => {
    const rules = normalizeSoftwarePolicyRules({
      software: [{ name: 'Firefox' }],
      allowUnknown: true,
    });

    const missing = evaluateSoftwareInventory('allowlist', rules, []).find((v) => v.type === 'missing');
    expect(missing?.rule?.name).toBe('Firefox');
    expect(missing?.rule?.catalogId).toBeUndefined();
  });

  /**
   * Contract D9 asks whether the new field changes violation matching.
   * `violationFingerprint` keys a `missing` violation on
   * `type:rule:name:minVersion:maxVersion` only (softwarePolicyService.ts:107-110),
   * so it must NOT. Pinned here so W02 can rely on it: a previously-stored
   * violation with no catalogId still stabilises the new one's detectedAt.
   */
  it('does not disturb detectedAt stabilisation against previously-stored violations', () => {
    const rules = normalizeSoftwarePolicyRules({
      software: [{ name: '7-Zip', catalogId: CATALOG_ID }],
      allowUnknown: true,
    });
    const next = evaluateSoftwareInventory('allowlist', rules, []);

    const previous = [{
      type: 'missing',
      rule: { name: '7-Zip' }, // stored before D9 shipped — no catalogId
      severity: 'high',
      detectedAt: '2026-01-01T00:00:00.000Z',
    }];

    const stabilised = withStableViolationTimestamps(next, previous);
    expect(stabilised[0]?.detectedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(stabilised[0]?.rule?.catalogId).toBe(CATALOG_ID);
  });
});
