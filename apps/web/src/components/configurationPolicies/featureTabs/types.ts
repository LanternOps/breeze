import type { ConfigFeatureType } from '@breeze/shared';
import { i18n } from '@/lib/i18n';
import { configFeatureLabel } from '../configPolicyLabels';

// Derived from the canonical CONFIG_FEATURE_TYPES (single source of truth in
// @breeze/shared) so the config-policy editor's feature tabs can't silently
// drift from the registry. Deriving via Exclude means a new canonical feature
// type makes FEATURE_META below fail to compile until a tab entry is added, and
// featureTypeParity.test.ts asserts the exclusion stays honest. (#2004)
//
// Every canonical feature type now has an editor tab (containment gained
// ContainmentTab in #10100), so the tuple is empty. It is kept so a future
// type that ships before its tab can be excluded here deliberately.
//
// FeatureType is sourced FROM this tuple (not a parallel literal) so the runtime
// exclusion list and the compile-time Exclude can't drift from each other.
export const EDITOR_EXCLUDED_FEATURE_TYPES = [] as const;
export type FeatureType = Exclude<ConfigFeatureType, typeof EDITOR_EXCLUDED_FEATURE_TYPES[number]>;

export type FeatureLink = {
  id: string;
  featureType: FeatureType;
  featurePolicyId: string | null;
  inlineSettings: Record<string, unknown> | null;
  /**
   * `security` links only (list/detail reads): 'reapproval_required' = auto-
   * quarantine is on but has no stored approval, so scans run detect-only
   * until a user with devices:execute saves the link.
   */
  autoQuarantineApproval?: 'approved' | 'legacy_grandfathered' | 'reapproval_required' | 'not_enabled';
  /** Why re-approval is required; 'approver_invalid' = the approver lost devices:execute or left. */
  autoQuarantineApprovalReason?: 'approver_invalid' | 'not_approved' | 'invalid_approval' | null;
  createdAt?: string;
  updatedAt?: string;
};

/** GET /configuration-policies/:id → parentPolicy (read-only embed; see spec "API"). */
export type ParentPolicySummary = {
  id: string;
  name: string;
  status: 'active' | 'inactive' | 'archived';
  orgId: string | null; // null = partner-wide parent
  featureLinks: FeatureLink[];
};

export type FeatureTabProps = {
  policyId: string;
  existingLink: FeatureLink | undefined;
  /** Own-or-parent links for advisory duplicate detection; monitors additionally include inheritedMonitorsLink. */
  allLinks?: FeatureLink[];
  /** Parent monitor attachments for cumulative advisory detection; never used for saves. */
  inheritedMonitorsLink?: FeatureLink;
  onLinkChanged: (link: FeatureLink | null, featureType: FeatureType) => void;
  /** Shared linked Configuration Policy ID (set at the policy level, not per-tab) */
  linkedPolicyId: string | null;
  /** Parent policy's feature link for this tab (for inheritance display) */
  parentLink?: FeatureLink | undefined;
  /**
   * Every feature link on the policy, including this tab's own. Read-only;
   * changes go through useFeatureLink and onLinkChanged.
   */
  siblingLinks?: FeatureLink[];
  /**
   * Org this policy is scoped to (null for partner-wide policies — #1724).
   * Optional: only tabs that need to make an org-scoped fetch on behalf of
   * the policy (e.g. OneDriveHelperTab -> OneDriveLibraryPicker's M365/Graph
   * calls) destructure it; every other tab ignores it.
   */
  orgId?: string | null;
  /**
   * Partner that owns a partner-wide policy (null for org policies). Lets the
   * Security tab's rule-set picker (#6267) offer a partner-wide policy only
   * its own partner's sets. Org policies are not narrowed by partner in the
   * picker; the server gate resolves the org's partner and decides.
   */
  partnerId?: string | null;
};

export const FEATURE_META: Record<FeatureType, {
  label: string;
  fetchUrl: string | null;
  description: string;
}> = {
  patch: { get label() { return configFeatureLabel('patch'); }, fetchUrl: '/update-rings',        description: 'Patch management settings' },
  monitors: { get label() { return configFeatureLabel('monitors'); }, fetchUrl: '/monitor-definitions', description: 'Monitors attached to this policy: condition, response, delivery and escalation in one object' },
  backup: { get label() { return configFeatureLabel('backup'); }, fetchUrl: '/backup/configs',      description: 'Backup schedule and retention' },
  security: { get label() { return configFeatureLabel('security'); }, fetchUrl: '/security/policies',   description: 'Security policy settings' },
  maintenance: { get label() { return configFeatureLabel('maintenance'); }, fetchUrl: '/maintenance/windows', description: 'Maintenance window settings' },
  compliance: { get label() { return configFeatureLabel('compliance'); }, fetchUrl: '/policies',            description: 'Compliance rules and enforcement' },
  automation: { get label() { return configFeatureLabel('automation'); }, fetchUrl: '/automations',         description: 'Automated tasks and responses' },
  event_log: { get label() { return configFeatureLabel('event_log'); }, fetchUrl: null,                   description: 'Event log collection tuning & retention' },
  software_policy: { get label() { return configFeatureLabel('software_policy'); }, fetchUrl: '/software-policies', description: 'Allowlist/blocklist software rules' },
  sensitive_data: { get label() { return configFeatureLabel('sensitive_data'); }, fetchUrl: '/sensitive-data/policies', description: 'Sensitive data scanning configuration' },
  peripheral_control: { get label() { return configFeatureLabel('peripheral_control'); }, fetchUrl: '/peripherals/policies', description: 'USB, Bluetooth, and Thunderbolt device policies' },
  warranty: { get label() { return configFeatureLabel('warranty'); }, fetchUrl: null,                   description: 'Warranty expiry alert thresholds' },
  helper: { get label() { return configFeatureLabel('helper'); }, fetchUrl: null,                   description: 'End-user Breeze Assist tray application' },
  remote_access: { get label() { return configFeatureLabel('remote_access'); }, fetchUrl: null,                   description: 'Remote desktop, proxy tunnels, and session limits' },
  pam: { get label() { return configFeatureLabel('pam'); }, fetchUrl: null,              description: 'Windows UAC elevation prompt capture (PAM)' },
  vulnerability: { get label() { return configFeatureLabel('vulnerability'); }, fetchUrl: null,       description: 'Enable per-device CVE correlation (vulnerability detection)' },
  onedrive_helper: { get label() { return configFeatureLabel('onedrive_helper'); }, fetchUrl: null, description: 'Silently sign in OneDrive, enforce Files On-Demand and Known Folder Move, and auto-mount SharePoint libraries per user.' },
  device_lifecycle: { get label() { return configFeatureLabel('device_lifecycle'); }, fetchUrl: null, description: 'Permanently delete removed devices after a retention window' },
  hardware_monitoring: { get label() { return configFeatureLabel('hardware_monitoring'); }, fetchUrl: null, description: 'RAID and disk health collection intervals' },
  time_sync: {
    get label() {
      return configFeatureLabel('time_sync');
    },
    fetchUrl: null,
    get description() {
      return i18n.t('devices:timeSync.management.description');
    },
  },
  workload_inventory: {
    get label() {
      return configFeatureLabel('workload_inventory');
    },
    fetchUrl: null,
    get description() {
      return i18n.t('devices:workloads.policy.description');
    },
  },
  security_agents: {
    get label() {
      return configFeatureLabel('security_agents');
    },
    fetchUrl: null,
    get description() {
      return i18n.t('policies:configurationPolicies.featureTabs.securityAgentsTab.description');
    },
  },
  system_protection: {
    get label() {
      return configFeatureLabel('system_protection');
    },
    fetchUrl: null,
    get description() {
      return i18n.t('policies:configurationPolicies.featureTabs.systemProtectionTab.description');
    },
  },
  containment: {
    get label() {
      return configFeatureLabel('containment');
    },
    fetchUrl: null,
    get description() {
      return i18n.t('policies:configurationPolicies.featureTabs.containmentTab.description');
    },
  },
  oem_updates: {
    get label() {
      return configFeatureLabel('oem_updates');
    },
    fetchUrl: null,
    get description() {
      return i18n.t('policies:configurationPolicies.featureTabs.vendorUpdatesTab.description');
    },
  },
  wake_on_lan: {
    get label() {
      return configFeatureLabel('wake_on_lan');
    },
    fetchUrl: null,
    get description() {
      return i18n.t('policies:configurationPolicies.featureTabs.wakeOnLanTab.description');
    },
  },
};
