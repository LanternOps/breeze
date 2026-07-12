export const DOCS_BASE_URL = 'https://docs.breezermm.com';

/** A per-tab documentation target, keyed by the page's URL-hash tab id. */
interface DocsTabEntry {
  /** Docs path relative to DOCS_BASE_URL */
  docsPath: string;
  /** Human-readable label shown in the help panel header */
  label: string;
}

interface DocsEntry {
  /** URL path prefix to match (longest match wins) */
  pattern: string;
  /** Docs path relative to DOCS_BASE_URL */
  docsPath: string;
  /** Human-readable label shown in the help panel header */
  label: string;
  /**
   * Optional per-tab docs, keyed by the first segment of the URL hash (e.g.
   * `#patches` or `#anomalies/<id>` → `patches` / `anomalies`). When the current
   * hash matches a key, that tab's doc wins over the page-level `docsPath`; an
   * unknown or absent hash falls back to `docsPath`. This is how tabbed pages
   * surface a dedicated doc per tab from the single global help button.
   */
  tabs?: Record<string, DocsTabEntry>;
}

/**
 * Mapping from web app URL paths to documentation pages.
 * Ordered from most-specific to least-specific so the first match wins.
 */
const docsMapping: DocsEntry[] = [
  // Settings — specific pages first
  { pattern: '/settings/users', docsPath: '/reference/users-and-roles/', label: 'Users & Roles' },
  { pattern: '/settings/enrollment-keys', docsPath: '/agents/enrollment-keys/', label: 'Enrollment Keys' },
  { pattern: '/settings/api-keys', docsPath: '/reference/api-keys/', label: 'API Keys' },
  { pattern: '/settings/connected-apps', docsPath: '/features/mcp-server/', label: 'Connected Apps & MCP' },
  {
    pattern: '/settings/organization',
    docsPath: '/reference/organizations-and-sites/',
    label: 'Organizations & Sites',
    // OrgSettingsPage tabs write the (kebab) tab id to the hash. `general`
    // falls back to the page-level Organizations & Sites doc.
    tabs: {
      contracts: { docsPath: '/features/contracts/', label: 'Contracts' },
      billing: { docsPath: '/features/invoices/', label: 'Billing' },
      branding: { docsPath: '/features/branding/', label: 'Branding' },
      portal: { docsPath: '/features/portal/', label: 'Customer Portal' },
      security: { docsPath: '/reference/users-and-roles/', label: 'Security' },
      'approval-security': { docsPath: '/features/approval-security/', label: 'Approval Security' },
      'remote-access': { docsPath: '/features/remote-access/', label: 'Remote Access' },
      'event-logs': { docsPath: '/features/event-log-forwarding/', label: 'Event Logs' },
      notifications: { docsPath: '/features/notifications/', label: 'Notifications' },
      ticketing: { docsPath: '/features/ticketing/', label: 'Ticketing' },
    },
  },
  { pattern: '/settings/sso', docsPath: '/reference/sso/', label: 'Single Sign-On' },
  { pattern: '/settings/ai-usage', docsPath: '/features/ai/', label: 'AI Assistant' },
  { pattern: '/settings/custom-fields', docsPath: '/features/custom-fields/', label: 'Custom Fields' },
  { pattern: '/settings/access-reviews', docsPath: '/reference/access-reviews/', label: 'Access Reviews' },
  { pattern: '/settings/notifications', docsPath: '/features/notifications/', label: 'Notifications' },
  { pattern: '/settings/branding', docsPath: '/features/branding/', label: 'Branding' },
  { pattern: '/settings/alert-templates', docsPath: '/features/alert-templates/', label: 'Alert Templates' },
  { pattern: '/settings/integrations/huntress', docsPath: '/features/edr-integrations/', label: 'EDR Integrations' },
  { pattern: '/settings/integrations/security', docsPath: '/features/edr-integrations/', label: 'Security Integrations' },
  { pattern: '/settings/integrations/communication', docsPath: '/features/notifications/', label: 'Communication Channels' },
  { pattern: '/settings/integrations/psa', docsPath: '/features/psa-integrations/', label: 'PSA Integrations' },
  { pattern: '/settings/webhooks', docsPath: '/features/webhooks/', label: 'Webhooks' },
  { pattern: '/settings/filters', docsPath: '/reference/filters-and-search/', label: 'Filters & Search' },
  { pattern: '/settings/organizations', docsPath: '/reference/organizations-and-sites/', label: 'Organizations' },
  { pattern: '/settings/sites', docsPath: '/reference/organizations-and-sites/', label: 'Sites' },
  {
    pattern: '/settings/partner',
    docsPath: '/reference/partner-management/',
    label: 'Partner Settings',
    // PartnerSettingsPage writes the canonical kebab hash per tab.
    // company/defaults fall back to the page-level Partner Management doc.
    tabs: {
      regional: { docsPath: '/reference/regional-settings/', label: 'Regional Settings' },
      security: { docsPath: '/reference/users-and-roles/', label: 'Security' },
      'remote-access': { docsPath: '/features/remote-access/', label: 'Remote Access' },
      'event-logs': { docsPath: '/features/event-log-forwarding/', label: 'Event Logs' },
      notifications: { docsPath: '/features/notifications/', label: 'Notifications' },
      ticketing: { docsPath: '/features/ticketing/', label: 'Ticketing' },
      'ai-budgets': { docsPath: '/features/ai/', label: 'AI Budgets' },
      branding: { docsPath: '/features/branding/', label: 'Branding' },
      'login-branding': { docsPath: '/features/branding/', label: 'Login Branding' },
    },
  },
  { pattern: '/settings/roles', docsPath: '/reference/users-and-roles/', label: 'Roles' },
  { pattern: '/settings/profile', docsPath: '/reference/users-and-roles/', label: 'Profile' },
  { pattern: '/settings/ticketing', docsPath: '/features/ticketing/', label: 'Ticketing' },
  { pattern: '/settings/catalog', docsPath: '/features/product-catalog/', label: 'Product Catalog' },
  { pattern: '/settings/billing', docsPath: '/features/online-payments/', label: 'Online Payments' },
  { pattern: '/settings', docsPath: '/reference/users-and-roles/', label: 'Settings' },

  // Admin / Partner
  { pattern: '/partner', docsPath: '/reference/partner-management/', label: 'Partner Management' },
  { pattern: '/admin/third-party-catalog', docsPath: '/features/patch-management/', label: 'Third-Party Catalog' },
  { pattern: '/admin/account-deletion-requests', docsPath: '/reference/account-deletion/', label: 'Account Deletion Requests' },
  { pattern: '/admin', docsPath: '/reference/partner-management/', label: 'Administration' },

  // Feature pages — specific sub-routes first
  { pattern: '/devices/groups', docsPath: '/features/device-groups/', label: 'Device Groups' },
  {
    pattern: '/devices',
    docsPath: '/features/devices/',
    label: 'Devices',
    // Device detail tabs (DeviceDetails.tsx) write the tab id to the hash.
    // Only tabs whose doc differs from the page-level Devices doc are listed;
    // overview/details/hardware/management fall back to /features/devices/.
    tabs: {
      'linked-profiles': { docsPath: '/features/linked-profiles/', label: 'Linked Profiles' },
      performance: { docsPath: '/features/performance-metrics/', label: 'Performance Metrics' },
      alerts: { docsPath: '/features/alerts/', label: 'Alerts' },
      anomalies: { docsPath: '/features/ml-insights/', label: 'Anomalies' },
      tickets: { docsPath: '/features/ticketing/', label: 'Tickets' },
      eventlog: { docsPath: '/features/event-log-forwarding/', label: 'Event Log' },
      monitoring: { docsPath: '/features/service-monitoring/', label: 'Service Monitoring' },
      compliance: { docsPath: '/features/configuration-policies/', label: 'Compliance' },
      software: { docsPath: '/features/software-inventory/', label: 'Software Inventory' },
      patches: { docsPath: '/features/patch-management/', label: 'Patch Management' },
      vulnerabilities: { docsPath: '/features/vulnerability-management/', label: 'Vulnerabilities' },
      peripherals: { docsPath: '/features/peripheral-control/', label: 'Peripheral Control' },
      scripts: { docsPath: '/features/scripts/', label: 'Scripts' },
      'effective-config': { docsPath: '/features/configuration-policies/', label: 'Effective Configuration' },
      onedrive: { docsPath: '/features/onedrive-helper/', label: 'OneDrive' },
      security: { docsPath: '/features/security/', label: 'Security' },
      playbooks: { docsPath: '/features/playbooks/', label: 'Playbooks' },
      activities: { docsPath: '/reference/audit-logs/', label: 'Activity Log' },
      connections: { docsPath: '/features/network-connections/', label: 'Network Connections' },
      'ip-history': { docsPath: '/features/ip-history/', label: 'IP History' },
      filesystem: { docsPath: '/features/filesystem-analysis/', label: 'Disk Cleanup' },
      'boot-performance': { docsPath: '/features/boot-performance/', label: 'Boot Performance' },
      backup: { docsPath: '/backup/overview/', label: 'Backup' },
    },
  },
  { pattern: '/alerts/rules', docsPath: '/features/alert-templates/', label: 'Alert Rules' },
  { pattern: '/alerts/channels', docsPath: '/features/alerts/', label: 'Notification Channels' },
  { pattern: '/alerts/correlations', docsPath: '/features/ml-insights/', label: 'Alert Correlations' },
  { pattern: '/alerts', docsPath: '/features/alerts/', label: 'Alerts' },
  { pattern: '/tickets', docsPath: '/features/ticketing/', label: 'Ticketing' },
  { pattern: '/timesheet', docsPath: '/features/ticketing/', label: 'Timesheet' },
  { pattern: '/billing/invoices', docsPath: '/features/invoices/', label: 'Invoices' },
  { pattern: '/billing/quotes', docsPath: '/features/quotes/', label: 'Quotes' },
  { pattern: '/billing', docsPath: '/features/invoices/', label: 'Billing' },
  { pattern: '/contracts', docsPath: '/features/contracts/', label: 'Recurring Contracts' },
  { pattern: '/scripts', docsPath: '/features/scripts/', label: 'Scripts' },
  { pattern: '/patches', docsPath: '/features/patch-management/', label: 'Patch Management' },
  { pattern: '/vulnerabilities', docsPath: '/features/vulnerability-management/', label: 'Vulnerability Management' },
  { pattern: '/remote/tools', docsPath: '/features/system-tools/', label: 'System Tools' },
  { pattern: '/remote', docsPath: '/features/remote-access/', label: 'Remote Access' },
  { pattern: '/discovery', docsPath: '/features/discovery/', label: 'Network Discovery' },
  { pattern: '/dns-security', docsPath: '/features/dns-security/', label: 'DNS Security' },
  { pattern: '/backup', docsPath: '/backup/overview/', label: 'Backup' },
  { pattern: '/c2c', docsPath: '/backup/cloud-to-cloud/', label: 'Cloud-to-Cloud Backup' },
  { pattern: '/dr', docsPath: '/backup/disaster-recovery/', label: 'Disaster Recovery' },
  { pattern: '/monitoring', docsPath: '/monitoring/stack/', label: 'Monitoring' },
  { pattern: '/snmp', docsPath: '/features/snmp/', label: 'SNMP' },
  { pattern: '/peripherals', docsPath: '/features/peripheral-control/', label: 'Peripheral Control' },
  { pattern: '/security/antivirus', docsPath: '/deploy/antivirus-exceptions/', label: 'Antivirus Exceptions' },
  { pattern: '/security/user-risk', docsPath: '/features/user-risk/', label: 'User Risk' },
  { pattern: '/security/edr', docsPath: '/features/edr-integrations/', label: 'EDR Operations' },
  { pattern: '/security', docsPath: '/features/security/', label: 'Security' },
  { pattern: '/pam', docsPath: '/features/pam/', label: 'Privileged Access' },
  { pattern: '/sensitive-data', docsPath: '/features/sensitive-data/', label: 'Sensitive Data' },
  { pattern: '/ai-risk', docsPath: '/features/user-risk/', label: 'AI Risk' },
  { pattern: '/cis-hardening', docsPath: '/features/cis-hardening/', label: 'CIS Hardening' },
  { pattern: '/audit-baselines', docsPath: '/features/audit-baselines/', label: 'Audit Baselines' },
  { pattern: '/software-inventory', docsPath: '/features/software-inventory/', label: 'Software Inventory' },
  { pattern: '/software-policies', docsPath: '/features/software-policies/', label: 'Software Policies' },
  {
    pattern: '/software',
    docsPath: '/features/software-inventory/',
    label: 'Software',
    tabs: {
      inventory: { docsPath: '/features/software-inventory/', label: 'Software Inventory' },
      policies: { docsPath: '/features/software-policies/', label: 'Software Policies' },
    },
  },
  {
    pattern: '/configuration-policies',
    docsPath: '/features/configuration-policies/',
    label: 'Configuration Policies',
    // Config-policy detail feature tabs are keyed by FeatureType (underscored).
    // overview/compliance_status/assignments fall back to the page-level doc.
    tabs: {
      patch: { docsPath: '/features/patch-management/', label: 'Patch Policy' },
      alert_rule: { docsPath: '/features/alerts/', label: 'Alert Rules' },
      backup: { docsPath: '/backup/policies/', label: 'Backup Policy' },
      security: { docsPath: '/features/security/', label: 'Security' },
      monitoring: { docsPath: '/features/service-monitoring/', label: 'Service Monitoring' },
      maintenance: { docsPath: '/features/maintenance-windows/', label: 'Maintenance Windows' },
      compliance: { docsPath: '/features/cis-hardening/', label: 'Compliance' },
      automation: { docsPath: '/features/automations/', label: 'Automations' },
      event_log: { docsPath: '/features/event-log-forwarding/', label: 'Event Logs' },
      software_policy: { docsPath: '/features/software-policies/', label: 'Software Policy' },
      sensitive_data: { docsPath: '/features/sensitive-data/', label: 'Data Discovery' },
      peripheral_control: { docsPath: '/features/peripheral-control/', label: 'Peripheral Control' },
      warranty: { docsPath: '/features/warranty-tracking/', label: 'Warranty Tracking' },
      helper: { docsPath: '/agents/helper/', label: 'Breeze Assist' },
      remote_access: { docsPath: '/features/remote-access/', label: 'Remote Access' },
      pam: { docsPath: '/features/pam/', label: 'Privileged Access' },
      vulnerability: { docsPath: '/features/vulnerability-management/', label: 'Vulnerability Scanning' },
      onedrive_helper: { docsPath: '/features/onedrive-helper/', label: 'OneDrive Helper' },
    },
  },
  { pattern: '/policies', docsPath: '/features/policy-management/', label: 'Policies' },
  { pattern: '/automations', docsPath: '/features/automations/', label: 'Automations' },
  { pattern: '/integrations/webhooks', docsPath: '/features/webhooks/', label: 'Webhooks' },
  { pattern: '/integrations', docsPath: '/features/integrations/', label: 'Integrations' },
  { pattern: '/incidents', docsPath: '/features/incident-response/', label: 'Incident Response' },
  { pattern: '/reports', docsPath: '/features/reports/', label: 'Reports' },
  { pattern: '/analytics', docsPath: '/features/reports/', label: 'Analytics' },
  { pattern: '/audit', docsPath: '/reference/audit-logs/', label: 'Audit Logs' },
  { pattern: '/logs', docsPath: '/features/log-shipping/', label: 'Log Shipping' },
  { pattern: '/fleet', docsPath: '/features/ai/', label: 'Fleet Orchestration' },
  { pattern: '/workspace', docsPath: '/features/ai/', label: 'AI Workspace' },

  // Account
  { pattern: '/account/delete', docsPath: '/reference/account-deletion/', label: 'Account Deletion' },
  { pattern: '/account/devices', docsPath: '/features/mobile/', label: 'Trusted Devices' },
  { pattern: '/account/test-approval', docsPath: '/features/mobile/', label: 'Approval Mode' },
  { pattern: '/account/connected-apps', docsPath: '/features/mcp-server/', label: 'Connected Apps & MCP' },

  // Standalone pages
  { pattern: '/setup', docsPath: '/features/setup-wizard/', label: 'Setup Wizard' },
  { pattern: '/profile', docsPath: '/reference/users-and-roles/', label: 'Profile' },

  // Dashboard fallback
  { pattern: '/', docsPath: '/getting-started/quickstart/', label: 'Getting Started' },
];

/**
 * Resolve the best-matching documentation URL and label for a given app path,
 * optionally narrowing to a tab-specific doc using the current URL hash.
 *
 * `hash` may be passed with or without a leading `#`; only its first
 * slash-delimited segment is used (so `#anomalies/<id>` matches the `anomalies`
 * tab). When it matches a tab of the winning path entry, that tab's doc is
 * returned; otherwise the page-level doc is used. Omitting `hash` preserves the
 * original path-only behavior.
 */
export function getDocsForPath(
  pathname: string,
  hash?: string,
): { url: string; label: string } {
  const normalized = pathname.replace(/\/$/, '') || '/';
  const tabKey = hash ? hash.replace(/^#/, '').split('/')[0] : '';

  for (const entry of docsMapping) {
    if (normalized === entry.pattern || normalized.startsWith(entry.pattern + '/')) {
      const tab = tabKey ? entry.tabs?.[tabKey] : undefined;
      if (tab) {
        return { url: `${DOCS_BASE_URL}${tab.docsPath}`, label: tab.label };
      }
      return { url: `${DOCS_BASE_URL}${entry.docsPath}`, label: entry.label };
    }
  }

  return { url: DOCS_BASE_URL, label: 'Documentation' };
}
