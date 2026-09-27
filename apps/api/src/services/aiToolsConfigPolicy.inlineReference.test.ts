import { describe, expect, it } from 'vitest';
import { COMPLIANCE_RULE_TYPES } from '@breeze/shared';
import {
  POLICY_FEATURE_INLINE_SETTINGS_REFERENCE,
  VALIDATED_INLINE_SETTINGS,
} from './aiToolsConfigPolicy';
import { INLINE_SETTINGS_EXAMPLES } from './aiToolsConfigPolicyExamples';
import { __evaluateRulesForDevice } from './policyEvaluationService';

// #6669 — the `describe` reference is the only shape documentation the model
// gets for inlineSettings. When it drifted from the evaluator (compliance
// `name` vs `softwareName`, `config_file_check` vs `config_check`) the model
// built rules that saved and then never evaluated. These tests tie the three
// together: reference text ⇄ example ⇄ write validator (⇄ evaluator for
// compliance).

function collectKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, out);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.add(key);
      collectKeys(child, out);
    }
  }
  return out;
}

describe('inline settings reference round-trip', () => {
  const validatedTypes = Object.keys(VALIDATED_INLINE_SETTINGS) as Array<keyof typeof POLICY_FEATURE_INLINE_SETTINGS_REFERENCE>;

  it('validates compliance inline settings', () => {
    expect(validatedTypes).toContain('compliance');
  });

  it.each(validatedTypes)('%s: the example passes the write validator', (featureType) => {
    const example = INLINE_SETTINGS_EXAMPLES[featureType];
    expect(example, `no INLINE_SETTINGS_EXAMPLES entry for ${featureType}`).toBeDefined();
    const parsed = VALIDATED_INLINE_SETTINGS[featureType]!.schema.safeParse(example);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it.each(validatedTypes)('%s: every field the example uses is named in the reference', (featureType) => {
    const reference = POLICY_FEATURE_INLINE_SETTINGS_REFERENCE[featureType];
    for (const key of collectKeys(INLINE_SETTINGS_EXAMPLES[featureType])) {
      expect(reference, `${featureType} reference does not mention "${key}"`).toMatch(new RegExp(`\\b${key}\\b`));
    }
  });

  it('compliance: the reference advertises exactly the rule types the evaluator handles', () => {
    const reference = POLICY_FEATURE_INLINE_SETTINGS_REFERENCE.compliance;
    const advertised = [...reference.matchAll(/type: "([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(advertised).toEqual([...COMPLIANCE_RULE_TYPES].sort());
    expect(reference).not.toContain('config_file_check');
  });

  it('compliance: the example exercises every rule type and every rule PASSES the evaluator on a matching device', () => {
    const example = INLINE_SETTINGS_EXAMPLES.compliance as { items: Array<{ rules: Array<{ type: string }> }> };
    const rules = example.items.flatMap((item) => item.rules);
    expect(new Set(rules.map((r) => r.type))).toEqual(new Set(COMPLIANCE_RULE_TYPES));

    // A device that satisfies every example rule. A rule whose fields the
    // evaluator does not read fails here with "... is missing ..." / "... requires ...".
    const result = __evaluateRulesForDevice(rules, {
      device: { osType: 'windows', osVersion: '10.0.22631' },
      software: [{ name: 'Contoso Endpoint Agent', version: '7.2.0' }],
      disks: [{ mountPoint: 'C:', freeGb: 200 }],
      registryState: [{ registryPath: 'HKLM\\SOFTWARE\\Policies\\Contoso', valueName: 'Enabled', valueData: '1' }],
      configState: [{ filePath: 'C:\\ProgramData\\Contoso\\agent.conf', configKey: 'TamperProtection', configValue: 'on' }],
    } as never);
    for (const detail of result.details) {
      expect(detail.passed, `${detail.ruleType}: ${detail.message}`).toBe(true);
    }
    expect(result.passed).toBe(true);
  });

  it('compliance: the documented required_software example FAILS once the app is removed', () => {
    const example = INLINE_SETTINGS_EXAMPLES.compliance as { items: Array<{ rules: Array<{ type: string }> }> };
    const required = example.items.flatMap((item) => item.rules).filter((r) => r.type === 'required_software');
    const result = __evaluateRulesForDevice(required, {
      device: { osType: 'windows', osVersion: '10.0.22631' },
      software: [],
    } as never);
    expect(result.passed).toBe(false);
    expect(result.details[0]?.message).toContain('is not installed');
  });
});
