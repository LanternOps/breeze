import type { ConfigFeatureType } from '@breeze/shared';

// Derived from the canonical CONFIG_FEATURE_TYPES (single source of truth in
// @breeze/shared) so the config-policy editor's feature tabs can't silently
// drift from the registry. `onedrive_helper` is deliberately excluded: it has
// no editor tab (the OneDrive Helper is configured elsewhere). Deriving via
// Exclude means a new canonical feature type makes FEATURE_META below fail to
// compile until a tab entry is added, and featureTypeParity.test.ts asserts the
// exclusion stays honest. (#2004)
export type FeatureType = Exclude<ConfigFeatureType, 'onedrive_helper'>;
export const EDITOR_EXCLUDED_FEATURE_TYPES = ['onedrive_helper'] as const;

export type FeatureLink = {
  id: string;
  featureType: FeatureType;
  featurePolicyId: string | null;
  inlineSettings: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
};

export type FeatureTabProps = {
  policyId: string;
  existingLink: FeatureLink | undefined;
  onLinkChanged: (link: FeatureLink | null, featureType: FeatureType) => void;
  /** Shared linked Configuration Policy ID (set at the policy level, not per-tab) */
  linkedPolicyId: string | null;
  /** Parent policy's feature link for this tab (for inheritance display) */
  parentLink?: FeatureLink | undefined;
};

export const FEATURE_META: Record<FeatureType, {
  label: string;
  fetchUrl: string | null;
  description: string;
}> = {
  patch:        { label: 'Patches',      fetchUrl: '/update-rings',        description: 'Patch management settings' },
  alert_rule:   { label: 'Alerts',       fetchUrl: '/alerts/rules',        description: 'Alert rule configuration' },
  backup:       { label: 'Backup',       fetchUrl: '/backup/configs',      description: 'Backup schedule and retention' },
  security:     { label: 'Security',     fetchUrl: '/security/policies',   description: 'Security policy settings' },
  monitoring:   { label: 'Monitoring',   fetchUrl: '/monitoring',          description: 'Service/process monitoring, event log alerts, and metric alert rules' },
  maintenance:  { label: 'Maintenance',  fetchUrl: '/maintenance/windows', description: 'Maintenance window settings' },
  compliance:   { label: 'Compliance',   fetchUrl: '/policies',            description: 'Compliance rules and enforcement' },
  automation:   { label: 'Automations',  fetchUrl: '/automations',         description: 'Automated tasks and responses' },
  event_log:    { label: 'Event Logs',   fetchUrl: null,                   description: 'Event log collection tuning & retention' },
  software_policy: { label: 'Software Policy', fetchUrl: '/software-policies', description: 'Allowlist/blocklist software rules' },
  sensitive_data: { label: 'Data Discovery', fetchUrl: '/sensitive-data/policies', description: 'Sensitive data scanning configuration' },
  peripheral_control: { label: 'Peripheral Control', fetchUrl: '/peripherals/policies', description: 'USB, Bluetooth, and Thunderbolt device policies' },
  warranty:    { label: 'Warranty',    fetchUrl: null,                   description: 'Warranty expiry alert thresholds' },
  helper:      { label: 'Breeze Assist',     fetchUrl: null,                   description: 'End-user Breeze Assist tray application' },
  remote_access: { label: 'Remote Access',  fetchUrl: null,                   description: 'Remote desktop, proxy tunnels, and session limits' },
  pam:         { label: 'Privileged Access', fetchUrl: null,              description: 'Windows UAC elevation prompt capture (PAM)' },
  vulnerability: { label: 'Vulnerability Scanning', fetchUrl: null,       description: 'Enable per-device CVE correlation (vulnerability detection)' },
};
