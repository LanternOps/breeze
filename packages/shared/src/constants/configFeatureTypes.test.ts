import { describe, expect, it } from 'vitest';
import {
  CONFIG_FEATURE_TYPES,
  RETIRED_CONFIG_FEATURE_TYPES,
  isRetiredConfigFeatureType,
  CONFIG_POLICY_FEATURE_TRUST_TIER,
  EXECUTION_GATED_FEATURE_TYPES,
  isExecutionGatedFeatureType,
  ORG_SCOPED_ONLY_FEATURE_TYPES,
} from './configFeatureTypes';

describe('config feature types after the alerting consolidation', () => {
  it('alert_rule and monitoring are retired, not canonical', () => {
    expect([...RETIRED_CONFIG_FEATURE_TYPES]).toEqual(['alert_rule', 'monitoring']);
    for (const t of RETIRED_CONFIG_FEATURE_TYPES) expect(CONFIG_FEATURE_TYPES as readonly string[]).not.toContain(t);
  });
  it('monitors stays canonical', () => { expect(CONFIG_FEATURE_TYPES).toContain('monitors'); });
  it('isRetiredConfigFeatureType narrows', () => {
    expect(isRetiredConfigFeatureType('alert_rule')).toBe(true);
    expect(isRetiredConfigFeatureType('monitors')).toBe(false);
    expect(isRetiredConfigFeatureType(undefined)).toBe(false);
  });
});

describe('CONFIG_POLICY_FEATURE_TRUST_TIER', () => {
  it('classifies every canonical feature type as protective or execution_gated', () => {
    for (const ft of CONFIG_FEATURE_TYPES) {
      const tier = CONFIG_POLICY_FEATURE_TRUST_TIER[ft];
      expect(tier, `feature type "${ft}" must be classified`).toBeDefined();
      expect(['protective', 'execution_gated']).toContain(tier);
    }
  });

  it('has no entries beyond the canonical feature-type list', () => {
    const known = new Set(CONFIG_FEATURE_TYPES);
    for (const key of Object.keys(CONFIG_POLICY_FEATURE_TRUST_TIER)) {
      expect(known.has(key as (typeof CONFIG_FEATURE_TYPES)[number])).toBe(true);
    }
  });

  it('classifies capability-granting/execution-bearing feature types as execution_gated', () => {
    for (const ft of ['pam', 'software_policy', 'automation', 'remote_access', 'helper', 'onedrive_helper', 'maintenance', 'security_agents', 'containment'] as const) {
      expect(CONFIG_POLICY_FEATURE_TRUST_TIER[ft]).toBe('execution_gated');
      expect(isExecutionGatedFeatureType(ft)).toBe(true);
      expect(EXECUTION_GATED_FEATURE_TYPES.has(ft)).toBe(true);
    }
  });

  it('security_agents (#6960) is canonical and execution_gated: it arms installs of third-party agents', () => {
    expect(CONFIG_FEATURE_TYPES).toContain('security_agents');
    expect(CONFIG_POLICY_FEATURE_TRUST_TIER.security_agents).toBe('execution_gated');
  });

  it('containment is partner-wide and execution-gated because extraAllow grants network permits', () => {
    expect(CONFIG_FEATURE_TYPES).toContain('containment');
    expect(CONFIG_POLICY_FEATURE_TRUST_TIER.containment).toBe('execution_gated');
    expect(ORG_SCOPED_ONLY_FEATURE_TYPES.has('containment')).toBe(false);
  });

  it('oem_updates is appended last, partner-wide, and protective (#11065, spec 4.1)', () => {
    expect(CONFIG_FEATURE_TYPES.at(-1)).toBe('oem_updates');
    // Protective, not execution_gated: dropping a group override that turns BIOS
    // off could expose a broader policy that turns it on. Arming is gated at write.
    expect(CONFIG_POLICY_FEATURE_TRUST_TIER.oem_updates).toBe('protective');
    expect(EXECUTION_GATED_FEATURE_TYPES.has('oem_updates')).toBe(false);
    expect(ORG_SCOPED_ONLY_FEATURE_TYPES.has('oem_updates')).toBe(false);
  });

  it('classifies protective/restrictive feature types as protective (never gated)', () => {
    for (const ft of ['security', 'peripheral_control', 'compliance', 'vulnerability', 'event_log', 'sensitive_data', 'device_lifecycle', 'monitors', 'hardware_monitoring', 'warranty', 'time_sync', 'workload_inventory', 'system_protection'] as const) {
      expect(CONFIG_POLICY_FEATURE_TRUST_TIER[ft]).toBe('protective');
      expect(isExecutionGatedFeatureType(ft)).toBe(false);
    }
  });

  // Patch and backup config-policy delivery does not
  // grant a device anything beyond what it already has on itself —
  // patch delivers ring/schedule metadata (not credentials) and backup
  // delivers a profile/destination reference (not storage credentials).
  // Dropping either for a refused device_group would silently stop real
  // patching/backups on a legitimate hostname- or tag-keyed group, so both
  // keep applying.
  it('classifies patch and backup as protective, not execution_gated', () => {
    for (const ft of ['patch', 'backup'] as const) {
      expect(CONFIG_POLICY_FEATURE_TRUST_TIER[ft]).toBe('protective');
      expect(isExecutionGatedFeatureType(ft)).toBe(false);
      expect(EXECUTION_GATED_FEATURE_TYPES.has(ft)).toBe(false);
    }
  });
});
