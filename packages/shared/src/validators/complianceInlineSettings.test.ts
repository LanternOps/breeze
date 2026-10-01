import { describe, expect, it } from 'vitest';
import {
  complianceInlineSettingsSchema,
  complianceItemName,
  COMPLIANCE_RULE_TYPES,
  duplicateComplianceItemNames,
} from './index';

// Field names here are the ones policyEvaluationService.ts reads (evaluateRule
// and its per-type evaluators) and the web ComplianceTab writes. #6669: the AI
// reference advertised `name` and `config_file_check`, which the evaluator
// never reads, so an assistant-built rule saved and then evaluated as
// "Required software rule is missing softwareName."
const item = (rules: unknown[]) => ({ items: [{ name: 'Baseline', enforcementLevel: 'monitor', checkIntervalMinutes: 60, rules }] });

describe('complianceInlineSettingsSchema', () => {
  it('lists exactly the rule types the evaluator switch handles', () => {
    expect([...COMPLIANCE_RULE_TYPES].sort()).toEqual([
      'config_check',
      'disk_space_minimum',
      'os_version',
      'prohibited_software',
      'registry_check',
      'required_software',
    ]);
  });

  it('accepts one well-formed rule of every type', () => {
    const r = complianceInlineSettingsSchema.safeParse(item([
      { type: 'required_software', softwareName: 'Contoso Agent' },
      { type: 'required_software', softwareName: 'Contoso Agent', softwareVersion: '7.1', versionOperator: 'gte' },
      { type: 'prohibited_software', prohibitedName: 'uTorrent' },
      { type: 'disk_space_minimum', minGb: 10, diskPath: 'C:' },
      { type: 'os_version', osType: 'windows', minOsVersion: '10.0.19045' },
      { type: 'registry_check', registryPath: 'HKLM\\SOFTWARE\\Contoso', registryValueName: 'Enabled', registryExpectedValue: '1' },
      { type: 'config_check', configFilePath: '/etc/ssh/sshd_config', configKey: 'PermitRootLogin', configExpectedValue: 'no' },
    ]));
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('accepts the shape the web Compliance tab saves (description, remediation, leftover keys from a type switch)', () => {
    const r = complianceInlineSettingsSchema.safeParse(item([
      {
        type: 'prohibited_software',
        description: 'SOC2 3.1a',
        prohibitedName: 'uTorrent',
        softwareName: '',
        softwareVersion: '',
        versionOperator: 'gte',
        remediation: { type: 'script', scriptId: '' },
      },
      { type: 'disk_space_minimum', minGb: 10, remediation: { type: 'none' } },
    ]));
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('accepts the evaluator aliases (softwareName on prohibited, diskSpaceGB, osMinVersion)', () => {
    const r = complianceInlineSettingsSchema.safeParse(item([
      { type: 'prohibited_software', softwareName: 'uTorrent' },
      { type: 'disk_space_minimum', diskSpaceGB: 20 },
      { type: 'os_version', osMinVersion: '14.0' },
    ]));
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('rejects a required_software rule that names the app with `name` (evaluator reads softwareName)', () => {
    const r = complianceInlineSettingsSchema.safeParse(item([{ type: 'required_software', name: 'Contoso Agent' }]));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('softwareName');
  });

  it('rejects `config_file_check` — the evaluator type is `config_check`', () => {
    const r = complianceInlineSettingsSchema.safeParse(item([
      { type: 'config_file_check', configFilePath: '/etc/x', configKey: 'k' },
    ]));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('config_check');
  });

  it('rejects a version operator without a version (evaluator fails the rule even when the app is installed)', () => {
    const r = complianceInlineSettingsSchema.safeParse(item([
      { type: 'required_software', softwareName: 'Contoso Agent', versionOperator: 'gte', softwareVersion: '' },
    ]));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('softwareVersion');
  });

  it('accepts versionOperator "any" with no version (presence only)', () => {
    const r = complianceInlineSettingsSchema.safeParse(item([
      { type: 'required_software', softwareName: 'Contoso Agent', versionOperator: 'any' },
    ]));
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it.each([
    ['prohibited_software', { type: 'prohibited_software' }, 'prohibitedName'],
    ['disk_space_minimum', { type: 'disk_space_minimum' }, 'minGb'],
    ['registry_check', { type: 'registry_check', registryPath: 'HKLM\\X' }, 'registryValueName'],
    ['config_check', { type: 'config_check', configFilePath: '/etc/x' }, 'configKey'],
    ['os_version', { type: 'os_version', osType: 'solaris' }, 'osType'],
  ])('rejects a %s rule missing what the evaluator requires', (_label, rule, field) => {
    const r = complianceInlineSettingsSchema.safeParse(item([rule]));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(field);
  });

  it('rejects an unknown enforcementLevel and an item with no rules', () => {
    expect(complianceInlineSettingsSchema.safeParse({ items: [{ name: 'x', enforcementLevel: 'block', rules: [{ type: 'disk_space_minimum', minGb: 5 }] }] }).success).toBe(false);
    expect(complianceInlineSettingsSchema.safeParse({ items: [{ name: 'x', rules: [] }] }).success).toBe(false);
  });
});

// A rule set is identified by (feature link, name): the evaluator's persisted
// state (automation_policy_compliance.config_item_name), the due check and the
// alert rule all key on it (#7518). Two rule sets with the same name in one
// link would share one state row and one alert, each overwriting the other.
describe('compliance rule set names', () => {
  const rules = [{ type: 'disk_space_minimum', minGb: 5 }];

  it('names an unnamed rule set the way the save path stores it', () => {
    expect(complianceItemName({ name: 'Baseline' }, 0)).toBe('Baseline');
    expect(complianceItemName({}, 2)).toBe('Compliance Rule 3');
    expect(complianceItemName({ name: undefined }, 0)).toBe('Compliance Rule 1');
  });

  it('finds names used by more than one rule set, including a stored default name', () => {
    expect(duplicateComplianceItemNames([{ name: 'A' }, { name: 'B' }])).toEqual([]);
    expect(duplicateComplianceItemNames([{ name: 'A' }, { name: 'B' }, { name: 'A' }, { name: 'A' }])).toEqual(['A']);
    // The second item has no name, so it is stored as "Compliance Rule 2".
    expect(duplicateComplianceItemNames([{ name: 'Compliance Rule 2' }, {}])).toEqual(['Compliance Rule 2']);
    // Names are compared exactly, as the database compares them.
    expect(duplicateComplianceItemNames([{ name: 'Disk' }, { name: 'disk' }])).toEqual([]);
    expect(duplicateComplianceItemNames(undefined)).toEqual([]);
  });

  it('rejects two rule sets with the same name and points at the second', () => {
    const r = complianceInlineSettingsSchema.safeParse({
      items: [{ name: 'Baseline', rules }, { name: 'Other', rules }, { name: 'Baseline', rules }],
    });
    expect(r.success).toBe(false);
    const issue = r.error?.issues.find((i) => i.path.join('.') === 'items.2.name');
    expect(issue?.message).toContain('"Baseline"');
  });

  it('accepts distinct names', () => {
    const r = complianceInlineSettingsSchema.safeParse({ items: [{ name: 'A', rules }, { name: 'B', rules }, { rules }] });
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
});
