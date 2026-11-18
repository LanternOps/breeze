import { describe, expect, it } from 'vitest';
import { __failedRuleRemediations, __isComplianceCheckDue, evaluateConfigPolicyComplianceRule } from './policyEvaluationService';
import {
  collectedPolicyStateProbesOf,
  derivePolicyStateProbesFromRules,
  policyConfigProbeKey,
  policyRegistryProbeKey,
} from './policyStateProbes';

// Helper to build a minimal complianceRule object.
// Cast as `any` to satisfy the Drizzle inferred type.
function makeRule(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'rule-1',
    featureLinkId: 'fl-1',
    name: 'Test Rule',
    description: null,
    rules: [],
    enforcementLevel: 'monitor',
    remediationScriptId: null,
    sortOrder: 0,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Helper to build a device evaluation context
function makeContext(overrides: Record<string, unknown> = {}): any {
  return {
    device: {
      id: 'dev-1',
      hostname: 'test-host',
      osType: 'windows',
      osVersion: '10.0.19045',
    },
    software: [],
    disks: [],
    registryState: [],
    configState: [],
    ...overrides,
  };
}

describe('evaluateConfigPolicyComplianceRule', () => {
  // ============================================
  // Compliant outcomes
  // ============================================

  describe('compliant outcomes', () => {
    it('returns compliant when required software is installed', () => {
      const rule = makeRule({
        rules: [{ type: 'required_software', softwareName: 'Chrome', versionOperator: 'any' }],
      });
      const ctx = makeContext({
        software: [{ name: 'Chrome', version: '120.0' }],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('compliant');
    });

    it('returns compliant when prohibited software is NOT installed', () => {
      const rule = makeRule({
        rules: [{ type: 'prohibited_software', prohibitedName: 'BitTorrent' }],
      });
      const ctx = makeContext({ software: [] });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('compliant');
    });

    it('returns compliant when disk space meets minimum', () => {
      const rule = makeRule({
        rules: [{ type: 'disk_space_minimum', minGb: 10 }],
      });
      const ctx = makeContext({
        disks: [{ mountPoint: 'C:', device: 'C:', freeGb: 50 }],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('compliant');
    });

    it('returns compliant when OS version meets minimum', () => {
      const rule = makeRule({
        rules: [{ type: 'os_version', osType: 'windows', minOsVersion: '10.0.19044' }],
      });
      const ctx = makeContext();
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('compliant');
    });
  });

  // ============================================
  // Non-compliant outcomes
  // ============================================

  describe('non-compliant outcomes', () => {
    it('returns non_compliant when required software is missing', () => {
      const rule = makeRule({
        rules: [{ type: 'required_software', softwareName: 'Missing App' }],
      });
      const ctx = makeContext({ software: [] });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('non_compliant');
    });

    it('returns non_compliant when prohibited software is installed', () => {
      const rule = makeRule({
        rules: [{ type: 'prohibited_software', prohibitedName: 'BitTorrent' }],
      });
      const ctx = makeContext({
        software: [{ name: 'BitTorrent', version: '7.11' }],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('non_compliant');
    });

    it('returns non_compliant when disk space is below minimum', () => {
      const rule = makeRule({
        rules: [{ type: 'disk_space_minimum', minGb: 100 }],
      });
      const ctx = makeContext({
        disks: [{ mountPoint: 'C:', device: 'C:', freeGb: 10 }],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('non_compliant');
    });

    it('returns non_compliant when OS version is below minimum', () => {
      const rule = makeRule({
        rules: [{ type: 'os_version', osType: 'windows', minOsVersion: '11.0.22000' }],
      });
      const ctx = makeContext();
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('non_compliant');
    });
  });

  // ============================================
  // Field alias coverage
  // ============================================

  describe('field aliases', () => {
    it('accepts minGb alias for disk_space_minimum', () => {
      const rule = makeRule({
        rules: [{ type: 'disk_space_minimum', minGb: 5 }],
      });
      const ctx = makeContext({
        disks: [{ mountPoint: '/', device: '/dev/sda1', freeGb: 10 }],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('compliant');
    });

    it('accepts diskSpaceGB alias for disk_space_minimum', () => {
      const rule = makeRule({
        rules: [{ type: 'disk_space_minimum', diskSpaceGB: 5 }],
      });
      const ctx = makeContext({
        disks: [{ mountPoint: '/', device: '/dev/sda1', freeGb: 10 }],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('compliant');
    });

    it('accepts minOsVersion alias for os_version', () => {
      const rule = makeRule({
        rules: [{ type: 'os_version', minOsVersion: '10.0.19044' }],
      });
      const ctx = makeContext();
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('compliant');
    });

    it('accepts osMinVersion alias for os_version', () => {
      const rule = makeRule({
        rules: [{ type: 'os_version', osMinVersion: '10.0.19044' }],
      });
      const ctx = makeContext();
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('compliant');
    });

    it('accepts prohibitedName alias for prohibited_software', () => {
      const rule = makeRule({
        rules: [{ type: 'prohibited_software', prohibitedName: 'Malware' }],
      });
      const ctx = makeContext({ software: [] });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('compliant');
    });

    it('accepts softwareName alias for prohibited_software', () => {
      const rule = makeRule({
        rules: [{ type: 'prohibited_software', softwareName: 'Malware' }],
      });
      const ctx = makeContext({ software: [] });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('compliant');
    });
  });

  // ============================================
  // Version operator aliases
  // ============================================

  describe('version operator aliases', () => {
    it('eq maps to exact', () => {
      const rule = makeRule({
        rules: [{ type: 'required_software', softwareName: 'Chrome', versionOperator: 'eq', softwareVersion: '120.0' }],
      });
      const ctx = makeContext({
        software: [{ name: 'Chrome', version: '120.0' }],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('compliant');
    });

    it('gte maps to minimum', () => {
      const rule = makeRule({
        rules: [{ type: 'required_software', softwareName: 'Chrome', versionOperator: 'gte', softwareVersion: '120.0' }],
      });
      const ctx = makeContext({
        software: [{ name: 'Chrome', version: '121.0' }],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('compliant');
    });

    it('gt maps to minimum', () => {
      const rule = makeRule({
        rules: [{ type: 'required_software', softwareName: 'Chrome', versionOperator: 'gt', softwareVersion: '120.0' }],
      });
      const ctx = makeContext({
        software: [{ name: 'Chrome', version: '121.0' }],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('compliant');
    });

    it('lte maps to maximum', () => {
      const rule = makeRule({
        rules: [{ type: 'required_software', softwareName: 'Chrome', versionOperator: 'lte', softwareVersion: '120.0' }],
      });
      const ctx = makeContext({
        software: [{ name: 'Chrome', version: '119.0' }],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('compliant');
    });
  });

  // ============================================
  // All rule types
  // ============================================

  describe('all rule types', () => {
    it('evaluates registry_check rule — pass', () => {
      const rule = makeRule({
        rules: [{
          type: 'registry_check',
          registryPath: 'HKLM\\SOFTWARE\\Test',
          registryValueName: 'Enabled',
          registryExpectedValue: '1',
        }],
      });
      const ctx = makeContext({
        registryState: [{
          registryPath: 'HKLM\\SOFTWARE\\Test',
          valueName: 'Enabled',
          valueData: '1',
          valueType: 'REG_SZ',
        }],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('compliant');
    });

    it('evaluates registry_check rule — fail (value mismatch)', () => {
      const rule = makeRule({
        rules: [{
          type: 'registry_check',
          registryPath: 'HKLM\\SOFTWARE\\Test',
          registryValueName: 'Enabled',
          registryExpectedValue: '1',
        }],
      });
      const ctx = makeContext({
        registryState: [{
          registryPath: 'HKLM\\SOFTWARE\\Test',
          valueName: 'Enabled',
          valueData: '0',
          valueType: 'REG_SZ',
        }],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('non_compliant');
    });

    it('registry_check mismatch records the outcome and expected value, never the observed value (#11976)', () => {
      // These details are stored verbatim (ruleResults) and returned to
      // devices:read callers; reading a registry value live needs more than
      // that, so the stored detail must not carry what the device reported.
      const rule = makeRule({
        rules: [{
          type: 'registry_check',
          registryPath: 'HKLM\\SOFTWARE\\Test',
          registryValueName: 'Enabled',
          registryExpectedValue: '1',
        }],
      });
      const ctx = makeContext({
        registryState: [{
          registryPath: 'HKLM\\SOFTWARE\\Test',
          valueName: 'Enabled',
          valueData: 'observed-0xBEEF',
          valueType: 'REG_SZ',
        }],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('non_compliant');
      expect(result.details).toHaveLength(1);
      expect(result.details[0]).toMatchObject({
        ruleType: 'registry_check',
        passed: false,
        data: { outcome: 'mismatched', expectedValue: '1' },
      });
      expect(result.details[0]?.data).not.toHaveProperty('actualValue');
      expect(result.details[0]?.data).not.toHaveProperty('valueType');
      expect(JSON.stringify(result.details)).not.toContain('observed-0xBEEF');
      expect(JSON.stringify(result.details)).not.toContain('REG_SZ');
    });

    it('registry_check not found records outcome not_found (#11976)', () => {
      const rule = makeRule({
        rules: [{ type: 'registry_check', registryPath: 'HKLM\\SOFTWARE\\Test', registryValueName: 'Enabled', registryExpectedValue: '1' }],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', makeContext());
      expect(result.details[0]).toMatchObject({ passed: false, data: { outcome: 'not_found', expectedValue: '1' } });
    });

    it('registry_check match records outcome matched (#11976)', () => {
      const rule = makeRule({
        rules: [{ type: 'registry_check', registryPath: 'HKLM\\SOFTWARE\\Test', registryValueName: 'Enabled', registryExpectedValue: '1' }],
      });
      const ctx = makeContext({
        registryState: [{ registryPath: 'HKLM\\SOFTWARE\\Test', valueName: 'Enabled', valueData: '1', valueType: 'REG_DWORD' }],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.details[0]).toMatchObject({ passed: true, data: { outcome: 'matched', expectedValue: '1' } });
      expect(JSON.stringify(result.details)).not.toContain('REG_DWORD');
    });

    it('config_check mismatch records the outcome and expected value, never the observed value (#12130)', () => {
      // Same permission boundary as registry_check: stored details are
      // readable with devices:read, a live read of the file is not.
      const rule = makeRule({
        rules: [{ type: 'config_check', configFilePath: '/etc/ssh/sshd_config', configKey: 'PermitRootLogin', configExpectedValue: 'no' }],
      });
      const ctx = makeContext({
        configState: [{ filePath: '/etc/ssh/sshd_config', configKey: 'PermitRootLogin', configValue: 'observed-yes-7f3a' }],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('non_compliant');
      expect(result.details[0]).toMatchObject({ passed: false, data: { outcome: 'mismatched', expectedValue: 'no' } });
      expect(result.details[0]?.data).not.toHaveProperty('actualValue');
      expect(JSON.stringify(result.details)).not.toContain('observed-yes-7f3a');
    });

    it('config_check records outcomes not_found and matched (#12130)', () => {
      const rule = makeRule({
        rules: [{ type: 'config_check', configFilePath: '/etc/ssh/sshd_config', configKey: 'PermitRootLogin', configExpectedValue: 'no' }],
      });
      expect(evaluateConfigPolicyComplianceRule(rule, 'dev-1', makeContext()).details[0])
        .toMatchObject({ passed: false, data: { outcome: 'not_found', expectedValue: 'no' } });
      const ctx = makeContext({
        configState: [{ filePath: '/etc/ssh/sshd_config', configKey: 'PermitRootLogin', configValue: 'no' }],
      });
      expect(evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx).details[0])
        .toMatchObject({ passed: true, data: { outcome: 'matched', expectedValue: 'no' } });
    });

    it('evaluates config_check rule — pass', () => {
      const rule = makeRule({
        rules: [{
          type: 'config_check',
          configFilePath: '/etc/ssh/sshd_config',
          configKey: 'PermitRootLogin',
          configExpectedValue: 'no',
        }],
      });
      const ctx = makeContext({
        device: { id: 'dev-1', hostname: 'test', osType: 'linux', osVersion: '22.04' },
        configState: [{
          filePath: '/etc/ssh/sshd_config',
          configKey: 'PermitRootLogin',
          configValue: 'no',
        }],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('compliant');
    });

    it('evaluates config_check rule — fail (key not found)', () => {
      const rule = makeRule({
        rules: [{
          type: 'config_check',
          configFilePath: '/etc/ssh/sshd_config',
          configKey: 'PermitRootLogin',
        }],
      });
      const ctx = makeContext({
        device: { id: 'dev-1', hostname: 'test', osType: 'linux', osVersion: '22.04' },
        configState: [],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('non_compliant');
    });

    it('registry_check passes on non-Windows device', () => {
      const rule = makeRule({
        rules: [{
          type: 'registry_check',
          registryPath: 'HKLM\\SOFTWARE\\Test',
          registryValueName: 'Enabled',
        }],
      });
      const ctx = makeContext({
        device: { id: 'dev-1', hostname: 'test', osType: 'linux', osVersion: '22.04' },
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('compliant');
    });
  });

  // ============================================
  // Edge cases
  // ============================================

  describe('edge cases', () => {
    it('returns non_compliant for empty rules array', () => {
      const rule = makeRule({ rules: [] });
      const ctx = makeContext();
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('non_compliant');
      expect(result.details[0]?.message).toContain('no rules');
    });

    it('returns non_compliant for unsupported rule type', () => {
      const rule = makeRule({
        rules: [{ type: 'unsupported_type' }],
      });
      const ctx = makeContext();
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('non_compliant');
      expect(result.details[0]?.message).toContain('Unsupported');
    });

    it('returns non_compliant for non-array rules input (null)', () => {
      const rule = makeRule({ rules: null });
      const ctx = makeContext();
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('non_compliant');
    });

    it('returns error status when evaluation throws unexpectedly', () => {
      const badRule = Object.create(null);
      Object.defineProperty(badRule, 'type', {
        get() { throw new Error('Corrupted JSONB data'); },
        enumerable: true,
      });
      const rule = makeRule({ rules: [badRule] });
      const ctx = makeContext();
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('error');
      expect(result.details[0]?.message).toContain('Failed to evaluate');
    });

    it('handles mixed pass/fail rules — one fail makes overall non_compliant', () => {
      const rule = makeRule({
        rules: [
          { type: 'required_software', softwareName: 'Chrome', versionOperator: 'any' },
          { type: 'required_software', softwareName: 'Missing App' },
        ],
      });
      const ctx = makeContext({
        software: [{ name: 'Chrome', version: '120.0' }],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('non_compliant');
      // First rule passes, second fails
      expect(result.details.length).toBe(2);
      expect(result.details[0]?.passed).toBe(true);
      expect(result.details[1]?.passed).toBe(false);
    });

    it('all rules pass → compliant', () => {
      const rule = makeRule({
        rules: [
          { type: 'required_software', softwareName: 'Chrome', versionOperator: 'any' },
          { type: 'disk_space_minimum', minGb: 5 },
        ],
      });
      const ctx = makeContext({
        software: [{ name: 'Chrome', version: '120.0' }],
        disks: [{ mountPoint: 'C:', device: 'C:', freeGb: 50 }],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('compliant');
    });

    it('os_version with osType any passes for any device OS', () => {
      const rule = makeRule({
        rules: [{ type: 'os_version', osType: 'any', minOsVersion: '10.0' }],
      });
      const ctx = makeContext();
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('compliant');
    });

    it('disk_space with specific diskPath filters to matching disk only', () => {
      const rule = makeRule({
        rules: [{ type: 'disk_space_minimum', minGb: 10, diskPath: 'D:' }],
      });
      const ctx = makeContext({
        disks: [
          { mountPoint: 'C:', device: 'C:', freeGb: 5 },
          { mountPoint: 'D:', device: 'D:', freeGb: 50 },
        ],
      });
      const result = evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx);
      expect(result.status).toBe('compliant');
    });
  });
});

/**
 * #12130: a rule whose value the org's agents are not asked to collect (its
 * probe is past the per-org cap, or the location is not collectable) was never
 * read. Absence of a probe is not evidence of non-compliance, so such a rule is
 * not assessed: it neither passes nor fails, and alone it leaves the rule set
 * `pending`, which raises no violation and runs no remediation.
 */
describe('rules whose value is not collected (#12130)', () => {
  const REG = { type: 'registry_check', registryPath: 'HKLM\\SOFTWARE\\Test', registryValueName: 'Enabled', registryExpectedValue: '1' };
  const CFG = { type: 'config_check', configFilePath: '/etc/ssh/sshd_config', configKey: 'PermitRootLogin', configExpectedValue: 'no' };
  const nothingCollected = { registry: new Set<string>(), config: new Set<string>() };
  const everythingCollected = {
    registry: new Set([policyRegistryProbeKey(REG.registryPath, REG.registryValueName)]),
    config: new Set([policyConfigProbeKey(CFG.configFilePath, CFG.configKey)]),
  };

  it('a registry_check that is not collected is not assessed and leaves the rule set pending', () => {
    const result = evaluateConfigPolicyComplianceRule(makeRule({ rules: [REG] }), 'dev-1',
      makeContext({ collectedProbes: nothingCollected }));
    expect(result.status).toBe('pending');
    expect(result.details[0]).toMatchObject({
      ruleType: 'registry_check',
      passed: null,
      data: { outcome: 'not_collected', expectedValue: '1' },
    });
    expect(result.details[0]!.message).toMatch(/^Not assessed/);
  });

  it('a stored value is not trusted for a rule that is no longer collected', () => {
    // A row can outlive the probe that wrote it; nothing refreshes it any more.
    const ctx = makeContext({
      collectedProbes: nothingCollected,
      registryState: [{ registryPath: REG.registryPath, valueName: REG.registryValueName, valueData: '0', valueType: 'REG_SZ' }],
    });
    expect(evaluateConfigPolicyComplianceRule(makeRule({ rules: [REG] }), 'dev-1', ctx).status).toBe('pending');
  });

  it('a config_check that is not collected is not assessed', () => {
    const result = evaluateConfigPolicyComplianceRule(makeRule({ rules: [CFG] }), 'dev-1',
      makeContext({ collectedProbes: nothingCollected }));
    expect(result.status).toBe('pending');
    expect(result.details[0]).toMatchObject({ ruleType: 'config_check', passed: null, data: { outcome: 'not_collected' } });
  });

  it('a collected value that is absent still fails', () => {
    const result = evaluateConfigPolicyComplianceRule(makeRule({ rules: [REG, CFG] }), 'dev-1',
      makeContext({ collectedProbes: everythingCollected }));
    expect(result.status).toBe('non_compliant');
    expect(result.details.map((d) => d.passed)).toEqual([false, false]);
    expect(result.details.map((d) => (d.data as { outcome?: string } | undefined)?.outcome)).toEqual(['not_found', 'not_found']);
  });

  it('matching is case-insensitive and ignores surrounding whitespace, like the probe list', () => {
    const rule = makeRule({ rules: [{ ...REG, registryPath: '  hklm\\software\\TEST ', registryValueName: 'ENABLED' }] });
    const ctx = makeContext({
      collectedProbes: everythingCollected,
      registryState: [{ registryPath: REG.registryPath, valueName: REG.registryValueName, valueData: '1', valueType: 'REG_SZ' }],
    });
    expect(evaluateConfigPolicyComplianceRule(rule, 'dev-1', ctx).status).toBe('compliant');
  });

  it('another failing rule still makes the rule set non-compliant; the uncollected rule stays not assessed', () => {
    const software = { type: 'required_software', softwareName: 'Contoso Agent', versionOperator: 'any' };
    const result = evaluateConfigPolicyComplianceRule(makeRule({ rules: [REG, software] }), 'dev-1',
      makeContext({ collectedProbes: nothingCollected }));
    expect(result.status).toBe('non_compliant');
    expect(result.details.map((d) => d.passed)).toEqual([null, false]);
  });

  it('passing rules plus an uncollected rule are pending, not compliant', () => {
    const os = { type: 'os_version', osType: 'any', minOsVersion: '10.0' };
    const result = evaluateConfigPolicyComplianceRule(makeRule({ rules: [os, REG] }), 'dev-1',
      makeContext({ collectedProbes: nothingCollected }));
    expect(result.status).toBe('pending');
  });

  it('a registry_check on a non-Windows device is still not applicable', () => {
    const ctx = makeContext({
      collectedProbes: nothingCollected,
      device: { id: 'dev-1', hostname: 'mac', osType: 'macos', osVersion: '15.0' },
    });
    expect(evaluateConfigPolicyComplianceRule(makeRule({ rules: [REG] }), 'dev-1', ctx).status).toBe('compliant');
  });

  it('names the reason: probe_cap for a collectable location, not_collectable otherwise', () => {
    const reasonOf = (r: unknown) => (evaluateConfigPolicyComplianceRule(makeRule({ rules: [r] }), 'dev-1',
      makeContext({ collectedProbes: nothingCollected })).details[0]!.data as { reason?: string }).reason;
    expect(reasonOf(REG)).toBe('probe_cap');
    expect(reasonOf(CFG)).toBe('probe_cap');
    expect(reasonOf({ ...REG, registryPath: 'HKLM\\SAM\\SAM\\Domains' })).toBe('not_collectable');
    expect(reasonOf({ ...CFG, configFilePath: '/etc/app/custom.conf' })).toBe('not_collectable');
  });

  it('agrees with the real probe builder: an off-allowlist config_check is not assessed, an allowlisted absent key fails', () => {
    const offList = { ...CFG, configFilePath: '/etc/app/custom.conf', configKey: 'Mode' };
    const onList = { ...CFG, configFilePath: '  /etc/ssh/sshd_config ', configKey: 'permitrootlogin' };
    const collected = collectedPolicyStateProbesOf({
      policy_registry_state_probes: [],
      policy_config_state_probes: derivePolicyStateProbesFromRules([offList, onList]).config,
    });
    const ctx = makeContext({ collectedProbes: collected });
    const off = evaluateConfigPolicyComplianceRule(makeRule({ rules: [offList] }), 'dev-1', ctx);
    expect(off.status).toBe('pending');
    expect(off.details[0]!.data).toMatchObject({ outcome: 'not_collected', reason: 'not_collectable' });
    const on = evaluateConfigPolicyComplianceRule(makeRule({ rules: [onList] }), 'dev-1', ctx);
    expect(on.status).toBe('non_compliant');
    expect(on.details[0]!.data).toMatchObject({ outcome: 'not_found' });
  });

  it('remediation never runs for a rule that was not assessed', () => {
    const remediation = { type: 'script', scriptId: 'script-1' };
    const software = { type: 'required_software', softwareName: 'Contoso Agent', versionOperator: 'any', remediation };
    const rules = [{ ...REG, remediation }, null, software];
    const result = evaluateConfigPolicyComplianceRule(makeRule({ rules }), 'dev-1',
      makeContext({ collectedProbes: nothingCollected }));
    expect(result.status).toBe('non_compliant');
    expect(__failedRuleRemediations(rules, result.details)).toEqual([remediation]);
  });
});

describe('__isComplianceCheckDue', () => {
  it('returns true when there is no prior evaluation timestamp', () => {
    expect(__isComplianceCheckDue(null, 60, Date.parse('2026-02-21T12:00:00Z'))).toBe(true);
  });

  it('returns false when interval has not elapsed yet', () => {
    const nowMs = Date.parse('2026-02-21T12:00:00Z');
    const lastCheckedAt = new Date('2026-02-21T11:45:01Z');
    expect(__isComplianceCheckDue(lastCheckedAt, 15, nowMs)).toBe(false);
  });

  it('returns true when interval has elapsed', () => {
    const nowMs = Date.parse('2026-02-21T12:00:00Z');
    const lastCheckedAt = new Date('2026-02-21T11:45:00Z');
    expect(__isComplianceCheckDue(lastCheckedAt, 15, nowMs)).toBe(true);
  });

  it('clamps invalid intervals to a safe minimum', () => {
    const nowMs = Date.parse('2026-02-21T12:00:00Z');
    const lastCheckedAt = new Date('2026-02-21T11:59:30Z');
    expect(__isComplianceCheckDue(lastCheckedAt, 0, nowMs)).toBe(false);
  });
});
