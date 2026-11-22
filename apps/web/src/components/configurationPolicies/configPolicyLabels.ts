import type { ConfigFeatureType } from '@breeze/shared';
import { i18n } from '@/lib/i18n';
import type { ConfigPolicyTargetLevel } from './appliesToSummary';

// One translated label set for configuration-policy features and assignment
// levels, shared by the policy editor's tabs, the policy list and the device
// Config tab (#12306). The editor's words win ("Patches", "Automations").
//
// Seven feature types were translated before this set existed; they keep the
// keys their tabs already use so their titles and labels cannot drift apart.
const EXISTING_FEATURE_LABEL_KEYS: Partial<Record<ConfigFeatureType, string>> = {
  time_sync: 'devices:timeSync.management.title',
  workload_inventory: 'devices:workloads.policy.title',
  security_agents: 'policies:configurationPolicies.featureTabs.securityAgentsTab.title',
  system_protection: 'policies:configurationPolicies.featureTabs.systemProtectionTab.title',
  containment: 'policies:configurationPolicies.featureTabs.containmentTab.title',
  oem_updates: 'policies:configurationPolicies.featureTabs.vendorUpdatesTab.title',
  wake_on_lan: 'policies:configurationPolicies.featureTabs.wakeOnLanTab.title',
};

/** The translated name of a configuration-policy feature, read at call time. */
export function configFeatureLabel(featureType: ConfigFeatureType): string {
  const key =
    EXISTING_FEATURE_LABEL_KEYS[featureType] ??
    `policies:configurationPolicies.featureNames.${featureType}.label`;
  return i18n.t(/* i18n-dynamic */ key);
}

/** The translated name of an assignment level; 'default' is the Breeze Defaults layer. */
export function configTargetLevelLabel(level: ConfigPolicyTargetLevel | 'default'): string {
  return i18n.t(/* i18n-dynamic */ `policies:configurationPolicies.levelNames.${level}.label`);
}
