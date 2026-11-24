import { i18n } from '@/lib/i18n';
import type { FeatureLink, FeatureType } from '../featureTabs/types';

/**
 * A feature's state on one policy, as the rail and the feature badge say it
 * (spec "States"; plan W03b H2).
 * - set_here: this policy has its own link and the parent has none.
 * - changed_from_parent: this policy's own link replaces the parent's.
 * - from_parent: only the parent policy has it; this policy inherits it.
 * - not_set: neither has it.
 * - unavailable: this policy cannot carry the feature (an org-only feature on
 *   an MSP-managed policy, spec Decision 4), whatever links exist.
 */
export type FeatureState = 'set_here' | 'from_parent' | 'changed_from_parent' | 'not_set' | 'unavailable';

export function featureState(
  own: FeatureLink | undefined,
  parent: FeatureLink | undefined,
  gated: boolean,
): FeatureState {
  if (gated) return 'unavailable';
  if (own && parent) return 'changed_from_parent';
  if (own) return 'set_here';
  if (parent) return 'from_parent';
  return 'not_set';
}

/** The translated words for a feature state, read at call time. */
export function featureStateLabel(state: FeatureState): string {
  return i18n.t(/* i18n-dynamic */ `policies:configurationPolicies.featureStates.${state}.label`);
}

export type FeatureRailGroupKey =
  | 'updates_software'
  | 'monitoring'
  | 'security'
  | 'backup'
  | 'access_end_user'
  | 'lifecycle';

/**
 * The rail's groups, in order (spec Decision 5; the full map is plan D18,
 * confirmed as Q4). Every feature appears exactly once; featureState.test.ts
 * holds this exhaustive over the canonical feature types.
 */
export const FEATURE_RAIL_GROUPS: readonly { key: FeatureRailGroupKey; features: readonly FeatureType[] }[] = [
  { key: 'updates_software', features: ['patch', 'oem_updates', 'software_policy'] },
  {
    key: 'monitoring',
    features: ['monitors', 'event_log', 'hardware_monitoring', 'workload_inventory', 'time_sync', 'warranty'],
  },
  {
    key: 'security',
    features: [
      'security',
      'security_agents',
      'containment',
      'vulnerability',
      'sensitive_data',
      'peripheral_control',
      'pam',
      'compliance',
    ],
  },
  { key: 'backup', features: ['backup', 'system_protection'] },
  { key: 'access_end_user', features: ['remote_access', 'helper', 'onedrive_helper', 'wake_on_lan'] },
  { key: 'lifecycle', features: ['maintenance', 'automation', 'device_lifecycle'] },
];

/** The feature a policy page opens on when the URL names none. */
export const FIRST_RAIL_FEATURE: FeatureType = FEATURE_RAIL_GROUPS[0].features[0];
