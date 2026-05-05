export const DOCS_BASE_URL = 'https://docs.breezermm.com';

interface DocsEntry {
  /** URL path prefix to match (longest match wins) */
  pattern: string;
  /** Docs path relative to DOCS_BASE_URL */
  docsPath: string;
  /** Human-readable label shown in the help panel header */
  label: string;
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
  { pattern: '/settings/organization', docsPath: '/reference/organizations-and-sites/', label: 'Organizations & Sites' },
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
  { pattern: '/settings/integrations/psa', docsPath: '/features/integrations/', label: 'PSA Integrations' },
  { pattern: '/settings/webhooks', docsPath: '/features/webhooks/', label: 'Webhooks' },
  { pattern: '/settings/filters', docsPath: '/reference/filters-and-search/', label: 'Filters & Search' },
  { pattern: '/settings/organizations', docsPath: '/reference/organizations-and-sites/', label: 'Organizations' },
  { pattern: '/settings/sites', docsPath: '/reference/organizations-and-sites/', label: 'Sites' },
  { pattern: '/settings/partner', docsPath: '/reference/partner-management/', label: 'Partner Settings' },
  { pattern: '/settings/roles', docsPath: '/reference/users-and-roles/', label: 'Roles' },
  { pattern: '/settings/profile', docsPath: '/reference/users-and-roles/', label: 'Profile' },
  { pattern: '/settings', docsPath: '/reference/users-and-roles/', label: 'Settings' },

  // Admin / Partner
  { pattern: '/partner', docsPath: '/reference/partner-management/', label: 'Partner Management' },
  { pattern: '/admin', docsPath: '/reference/partner-management/', label: 'Administration' },

  // Feature pages — specific sub-routes first
  { pattern: '/devices/groups', docsPath: '/features/device-groups/', label: 'Device Groups' },
  { pattern: '/devices', docsPath: '/features/device-groups/', label: 'Device Management' },
  { pattern: '/alerts/rules', docsPath: '/features/alert-templates/', label: 'Alert Rules' },
  { pattern: '/alerts/channels', docsPath: '/features/alerts/', label: 'Notification Channels' },
  { pattern: '/alerts', docsPath: '/features/alerts/', label: 'Alerts' },
  { pattern: '/scripts', docsPath: '/features/scripts/', label: 'Scripts' },
  { pattern: '/patches', docsPath: '/features/patch-management/', label: 'Patch Management' },
  { pattern: '/remote/tools', docsPath: '/features/system-tools/', label: 'System Tools' },
  { pattern: '/remote', docsPath: '/features/remote-access/', label: 'Remote Access' },
  { pattern: '/discovery', docsPath: '/features/discovery/', label: 'Network Discovery' },
  { pattern: '/backup', docsPath: '/backup/overview/', label: 'Backup' },
  { pattern: '/c2c', docsPath: '/backup/cloud-to-cloud/', label: 'Cloud-to-Cloud Backup' },
  { pattern: '/dr', docsPath: '/backup/disaster-recovery/', label: 'Disaster Recovery' },
  { pattern: '/monitoring', docsPath: '/monitoring/stack/', label: 'Monitoring' },
  { pattern: '/snmp', docsPath: '/features/snmp/', label: 'SNMP' },
  { pattern: '/peripherals', docsPath: '/features/peripheral-control/', label: 'Peripheral Control' },
  { pattern: '/security/antivirus', docsPath: '/deploy/antivirus-exceptions/', label: 'Antivirus Exceptions' },
  { pattern: '/security', docsPath: '/features/security/', label: 'Security' },
  { pattern: '/sensitive-data', docsPath: '/features/sensitive-data/', label: 'Sensitive Data' },
  { pattern: '/ai-risk', docsPath: '/features/user-risk/', label: 'AI Risk' },
  { pattern: '/cis-hardening', docsPath: '/features/cis-hardening/', label: 'CIS Hardening' },
  { pattern: '/audit-baselines', docsPath: '/features/audit-baselines/', label: 'Audit Baselines' },
  { pattern: '/software-inventory', docsPath: '/features/software-inventory/', label: 'Software Inventory' },
  { pattern: '/software-policies', docsPath: '/features/software-policies/', label: 'Software Policies' },
  { pattern: '/software', docsPath: '/features/software-inventory/', label: 'Software' },
  { pattern: '/configuration-policies', docsPath: '/features/configuration-policies/', label: 'Configuration Policies' },
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

  // Standalone pages
  { pattern: '/setup', docsPath: '/features/setup-wizard/', label: 'Setup Wizard' },
  { pattern: '/profile', docsPath: '/reference/users-and-roles/', label: 'Profile' },

  // Dashboard fallback
  { pattern: '/', docsPath: '/getting-started/quickstart/', label: 'Getting Started' },
];

/**
 * Resolve the best-matching documentation URL and label for a given app path.
 */
export function getDocsForPath(pathname: string): { url: string; label: string } {
  const normalized = pathname.replace(/\/$/, '') || '/';

  for (const entry of docsMapping) {
    if (normalized === entry.pattern || normalized.startsWith(entry.pattern + '/')) {
      return { url: `${DOCS_BASE_URL}${entry.docsPath}`, label: entry.label };
    }
  }

  return { url: DOCS_BASE_URL, label: 'Documentation' };
}
