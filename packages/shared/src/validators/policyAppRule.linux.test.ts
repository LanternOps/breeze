import { describe, expect, it } from 'vitest';
import { canonicalAppRuleKey, policyAppRuleSchema, ringAppRulesSchema } from './index';

// #9370: ring application rules can target Linux OS packages (apt/dnf) by name.
describe('policyAppRuleSchema — Linux package rules (#9370)', () => {
  it('accepts a linux block rule and a linux pin rule', () => {
    expect(policyAppRuleSchema.safeParse({ source: 'linux', packageId: 'docker-ce', action: 'block' }).success).toBe(true);
    expect(
      policyAppRuleSchema.safeParse({
        source: 'linux',
        packageId: 'docker-ce',
        action: 'pin',
        pinnedVersion: '5:24.0.7-1~ubuntu.22.04~jammy',
      }).success
    ).toBe(true);
  });

  it('still rejects sources that have no rule semantics (microsoft, apple, os)', () => {
    for (const source of ['microsoft', 'apple', 'os']) {
      expect(policyAppRuleSchema.safeParse({ source, packageId: 'x', action: 'block' }).success).toBe(false);
    }
  });
});

describe('canonicalAppRuleKey — linux bucket (#9370)', () => {
  it('matches a bare package name against the provider-prefixed id the agent reports', () => {
    expect(canonicalAppRuleKey('linux', 'docker-ce')).toBe('linux|docker-ce');
    expect(canonicalAppRuleKey('linux', 'apt:docker-ce')).toBe('linux|docker-ce');
    expect(canonicalAppRuleKey('linux', 'yum:Docker-CE')).toBe('linux|docker-ce');
    expect(canonicalAppRuleKey('linux', 'dnf:docker-ce')).toBe('linux|docker-ce');
  });

  it('does not strip provider prefixes outside the linux bucket', () => {
    expect(canonicalAppRuleKey('third_party', 'apt:docker-ce')).toBe('third_party|apt:docker-ce');
  });

  it('keeps linux and third-party rules for the same name distinct', () => {
    expect(canonicalAppRuleKey('linux', 'docker-ce')).not.toBe(canonicalAppRuleKey('third_party', 'docker-ce'));
  });
});

describe('ringAppRulesSchema — linux duplicates (#9370)', () => {
  it('rejects the same linux package written with and without a provider prefix', () => {
    const result = ringAppRulesSchema.safeParse([
      { source: 'linux', packageId: 'docker-ce', action: 'block' },
      { source: 'linux', packageId: 'apt:docker-ce', action: 'block' },
    ]);
    expect(result.success).toBe(false);
  });

  it('allows a linux rule and a third-party rule with the same name', () => {
    const result = ringAppRulesSchema.safeParse([
      { source: 'linux', packageId: 'docker-ce', action: 'block' },
      { source: 'third_party', packageId: 'docker-ce', action: 'block' },
    ]);
    expect(result.success).toBe(true);
  });
});
