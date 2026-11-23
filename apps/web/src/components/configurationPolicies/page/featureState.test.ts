import { describe, expect, it } from 'vitest';
import { CONFIG_FEATURE_TYPES } from '@breeze/shared';
import { FEATURE_RAIL_GROUPS, featureState } from './featureState';
import { FEATURE_META, type FeatureLink, type FeatureType } from '../featureTabs/types';

const link = (featureType: FeatureType): FeatureLink => ({
  id: `link-${featureType}`,
  featureType,
  featurePolicyId: null,
  inlineSettings: {},
});

describe('featureState (#12469)', () => {
  it('featureState covers the five states', () => {
    expect(featureState(undefined, undefined, false)).toBe('not_set');
    expect(featureState(link('patch'), undefined, false)).toBe('set_here');
    expect(featureState(undefined, link('patch'), false)).toBe('from_parent');
    expect(featureState(link('patch'), link('patch'), false)).toBe('changed_from_parent');
    // A feature the policy cannot carry is unavailable, even with a leftover link.
    expect(featureState(undefined, undefined, true)).toBe('unavailable');
    expect(featureState(link('onedrive_helper'), undefined, true)).toBe('unavailable');
  });
});

describe('FEATURE_RAIL_GROUPS (#12469, spec Decision 5, plan D18)', () => {
  it('FEATURE_RAIL_GROUPS places every feature exactly once', () => {
    const placed = FEATURE_RAIL_GROUPS.flatMap((g) => g.features);
    expect(new Set(placed).size).toBe(placed.length);
    expect([...placed].sort()).toEqual((Object.keys(FEATURE_META) as FeatureType[]).sort());
    expect([...placed].sort()).toEqual([...CONFIG_FEATURE_TYPES].sort());
  });

  it('keeps the six groups in the decided order', () => {
    expect(FEATURE_RAIL_GROUPS.map((g) => g.key)).toEqual([
      'updates_software',
      'monitoring',
      'security',
      'backup',
      'access_end_user',
      'lifecycle',
    ]);
  });

  it('places features as the plan decided (D18)', () => {
    const byGroup = Object.fromEntries(FEATURE_RAIL_GROUPS.map((g) => [g.key, [...g.features]]));
    expect(byGroup).toEqual({
      updates_software: ['patch', 'oem_updates', 'software_policy'],
      monitoring: ['monitors', 'event_log', 'hardware_monitoring', 'workload_inventory', 'time_sync', 'warranty'],
      security: [
        'security',
        'security_agents',
        'containment',
        'vulnerability',
        'sensitive_data',
        'peripheral_control',
        'pam',
        'compliance',
      ],
      backup: ['backup', 'system_protection'],
      access_end_user: ['remote_access', 'helper', 'onedrive_helper', 'wake_on_lan'],
      lifecycle: ['maintenance', 'automation', 'device_lifecycle'],
    });
  });
});
