export type FeatureType = 'patch' | 'alert_rule' | 'backup' | 'security' | 'monitoring' | 'maintenance' | 'compliance' | 'automation';

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
  patch:        { label: 'Patches',      fetchUrl: '/patch-policies',      description: 'Patch management settings' },
  alert_rule:   { label: 'Alerts',       fetchUrl: '/alerts/rules',        description: 'Alert rule configuration' },
  backup:       { label: 'Backup',       fetchUrl: '/backup/configs',      description: 'Backup schedule and retention' },
  security:     { label: 'Security',     fetchUrl: '/security/policies',   description: 'Security policy settings' },
  monitoring:   { label: 'Monitoring',   fetchUrl: '/monitoring',          description: 'Monitoring check configuration' },
  maintenance:  { label: 'Maintenance',  fetchUrl: '/maintenance/windows', description: 'Maintenance window settings' },
  compliance:   { label: 'Compliance',   fetchUrl: '/policies',            description: 'Compliance rules and enforcement' },
  automation:   { label: 'Automations',  fetchUrl: '/automations',         description: 'Automated tasks and responses' },
};
