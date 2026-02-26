import type { LucideIcon } from 'lucide-react';
import { Eye, ShieldCheck, ShieldAlert, ShieldOff } from 'lucide-react';

export interface TierDefinition {
  tier: 1 | 2 | 3 | 4;
  label: string;
  description: string;
  icon: LucideIcon;
  borderColor: string;
  badgeBg: string;
  badgeText: string;
  tools: Array<{ name: string; description: string }>;
}

export const TIER_DEFINITIONS: TierDefinition[] = [
  {
    tier: 1,
    label: 'Auto-Execute (Read-Only)',
    description: 'Read-only operations that execute automatically without any approval or logging overhead.',
    icon: Eye,
    borderColor: 'border-l-green-500',
    badgeBg: 'bg-green-500/15',
    badgeText: 'text-green-700',
    tools: [
      // Device & metrics
      { name: 'query_devices', description: 'Search and filter devices' },
      { name: 'get_device_details', description: 'Get comprehensive device info' },
      { name: 'analyze_metrics', description: 'Time-series metrics analysis' },
      { name: 'get_active_users', description: 'Active user sessions' },
      { name: 'get_user_experience_metrics', description: 'Login performance and session trends' },
      { name: 'get_fleet_health', description: 'Fleet health overview and aggregates' },
      { name: 'analyze_boot_performance', description: 'Boot performance analysis' },
      { name: 'analyze_disk_usage', description: 'Filesystem analysis' },
      // Network
      { name: 'get_network_changes', description: 'Network change detection' },
      { name: 'get_ip_history', description: 'IP address history' },
      { name: 'get_dns_security', description: 'DNS security analysis' },
      // Alerts & security
      { name: 'manage_alerts (list/get)', description: 'View alerts' },
      { name: 'get_security_posture', description: 'Security posture scores' },
      // Files & disk
      { name: 'file_operations (list/read)', description: 'List and read files' },
      { name: 'disk_cleanup (preview)', description: 'Preview cleanup candidates' },
      // Audit & logs
      { name: 'query_audit_log', description: 'Search audit logs' },
      { name: 'query_change_log', description: 'Device change log search' },
      { name: 'search_logs', description: 'Event log search' },
      { name: 'get_log_trends', description: 'Log trend analysis' },
      { name: 'search_agent_logs', description: 'Agent diagnostic log search' },
      // Brain device context
      { name: 'get_device_context', description: 'Brain device context lookup' },
      // Software & playbooks
      { name: 'list_playbooks', description: 'List self-healing playbooks' },
      { name: 'get_playbook_history', description: 'Playbook execution history' },
      { name: 'get_software_compliance', description: 'Software compliance checks' },
      // Configuration policies
      { name: 'list_configuration_policies', description: 'List config policies' },
      { name: 'get_configuration_policy', description: 'Get config policy details' },
      { name: 'get_effective_configuration', description: 'Effective config resolution' },
      { name: 'preview_configuration_change', description: 'Preview config impact' },
      { name: 'configuration_policy_compliance', description: 'Policy compliance status' },
      // Fleet tools (read actions)
      { name: 'manage_deployments (list/get)', description: 'View deployments' },
      { name: 'manage_patches (list/compliance)', description: 'View patches and compliance' },
      { name: 'manage_groups (list/get/preview)', description: 'View device groups' },
      { name: 'manage_maintenance_windows (list/get)', description: 'View maintenance windows' },
      { name: 'manage_automations (list/get/history)', description: 'View automations' },
      { name: 'manage_alert_rules (list/get/test)', description: 'View alert rules' },
      { name: 'generate_report (list/data/history)', description: 'View reports' },
    ],
  },
  {
    tier: 2,
    label: 'Auto-Execute + Audit',
    description: 'Low-risk mutations that execute automatically but are logged to the audit trail.',
    icon: ShieldCheck,
    borderColor: 'border-l-blue-500',
    badgeBg: 'bg-blue-500/15',
    badgeText: 'text-blue-700',
    tools: [
      // Alerts
      { name: 'manage_alerts (acknowledge)', description: 'Acknowledge alerts' },
      { name: 'manage_alerts (resolve)', description: 'Resolve alerts' },
      // Services
      { name: 'manage_services (list)', description: 'List services on device' },
      // Network
      { name: 'acknowledge_network_device', description: 'Acknowledge network device' },
      { name: 'configure_network_baseline', description: 'Configure network baseline' },
      { name: 'manage_dns_policy', description: 'DNS policy management' },
      // Screenshots & screen
      { name: 'take_screenshot', description: 'Capture device screenshot' },
      { name: 'analyze_screen', description: 'Analyze captured screenshot' },
      // Brain device context
      { name: 'set_device_context', description: 'Set brain device context' },
      { name: 'resolve_device_context', description: 'Resolve brain device context' },
      // Logs
      { name: 'detect_log_correlations', description: 'Log correlation detection' },
      { name: 'set_agent_log_level', description: 'Set agent log level' },
      // Configuration policies
      { name: 'apply_configuration_policy', description: 'Assign config policy' },
      { name: 'remove_configuration_policy_assignment', description: 'Remove config assignment' },
      { name: 'manage_configuration_policy (activate/deactivate)', description: 'Toggle policy status' },
      // Fleet tools (low-risk mutations)
      { name: 'manage_deployments (pause/resume)', description: 'Pause or resume deployments' },
      { name: 'manage_patches (approve/decline/defer)', description: 'Patch approval decisions' },
      { name: 'manage_groups (add/remove devices)', description: 'Manage group membership' },
      { name: 'manage_maintenance_windows (create/update)', description: 'Create or update maintenance windows' },
      { name: 'manage_automations (enable/disable)', description: 'Toggle automation status' },
      { name: 'manage_alert_rules (create/update)', description: 'Create or update alert rules' },
      { name: 'generate_report (create/update/delete/generate)', description: 'Report management' },
    ],
  },
  {
    tier: 3,
    label: 'Requires Approval',
    description: 'Destructive or mutating operations that require explicit user approval before execution.',
    icon: ShieldAlert,
    borderColor: 'border-l-amber-500',
    badgeBg: 'bg-amber-500/15',
    badgeText: 'text-amber-700',
    tools: [
      // Device commands
      { name: 'execute_command', description: 'Execute system commands on device' },
      { name: 'run_script', description: 'Run scripts on up to 10 devices' },
      { name: 'computer_control', description: 'Send input actions to device' },
      // Services
      { name: 'manage_services (start/stop/restart)', description: 'Mutate device services' },
      { name: 'manage_startup_items (enable/disable)', description: 'Manage startup items' },
      // Security
      { name: 'security_scan (quarantine/remove/restore)', description: 'Threat management actions' },
      // Files & disk
      { name: 'file_operations (write/delete/mkdir/rename)', description: 'Mutate files on device' },
      { name: 'disk_cleanup (execute)', description: 'Execute disk cleanup' },
      // Network
      { name: 'network_discovery', description: 'Network discovery scan' },
      // Playbooks & software
      { name: 'execute_playbook', description: 'Execute self-healing playbook' },
      { name: 'manage_software_policy', description: 'Software policy management' },
      { name: 'remediate_software_violation', description: 'Remediate software violations' },
      // Configuration policies
      { name: 'manage_configuration_policy (create/update/delete)', description: 'Create, update, or delete config policies' },
      // Fleet tools (destructive actions)
      { name: 'manage_deployments (create/start/cancel)', description: 'Create, start, or cancel deployments' },
      { name: 'manage_patches (scan/install/rollback)', description: 'Scan, install, or rollback patches' },
      { name: 'manage_groups (create/update/delete)', description: 'Create, update, or delete device groups' },
      { name: 'manage_maintenance_windows (delete)', description: 'Delete maintenance windows' },
      { name: 'manage_automations (create/update/delete/run)', description: 'Manage automation lifecycle' },
      { name: 'manage_alert_rules (delete)', description: 'Delete alert rules' },
    ],
  },
  {
    tier: 4,
    label: 'Blocked',
    description: 'Operations that are never allowed, such as cross-organization data access or unknown tools.',
    icon: ShieldOff,
    borderColor: 'border-l-red-500',
    badgeBg: 'bg-red-500/15',
    badgeText: 'text-red-700',
    tools: [
      { name: 'Cross-org access', description: 'Any operation targeting resources outside the current organization' },
      { name: 'Unknown tools', description: 'Any unregistered tool invocation is blocked' },
    ],
  },
];

export interface RateLimitConfig {
  toolName: string;
  limit: number;
  windowSeconds: number;
  tier: 1 | 2 | 3;
  permission: string;
}

export const RATE_LIMIT_CONFIGS: RateLimitConfig[] = [
  // Device commands
  { toolName: 'execute_command', limit: 10, windowSeconds: 300, tier: 3, permission: 'devices.execute' },
  { toolName: 'run_script', limit: 5, windowSeconds: 300, tier: 3, permission: 'scripts.execute' },
  { toolName: 'computer_control', limit: 20, windowSeconds: 300, tier: 3, permission: 'devices.execute' },
  // Services & startup
  { toolName: 'manage_services', limit: 10, windowSeconds: 300, tier: 3, permission: 'devices.execute' },
  { toolName: 'manage_startup_items', limit: 5, windowSeconds: 600, tier: 3, permission: 'devices.execute' },
  // Security
  { toolName: 'security_scan', limit: 3, windowSeconds: 600, tier: 3, permission: 'devices.execute' },
  // Files & disk
  { toolName: 'file_operations', limit: 20, windowSeconds: 300, tier: 3, permission: 'devices.execute' },
  { toolName: 'analyze_disk_usage', limit: 10, windowSeconds: 300, tier: 1, permission: 'devices.read' },
  { toolName: 'disk_cleanup', limit: 3, windowSeconds: 600, tier: 3, permission: 'devices.execute' },
  // Network
  { toolName: 'network_discovery', limit: 2, windowSeconds: 600, tier: 3, permission: 'devices.execute' },
  // Screenshots
  { toolName: 'take_screenshot', limit: 10, windowSeconds: 300, tier: 2, permission: 'devices.execute' },
  { toolName: 'analyze_screen', limit: 10, windowSeconds: 300, tier: 2, permission: 'devices.execute' },
  // Logs
  { toolName: 'search_logs', limit: 30, windowSeconds: 300, tier: 1, permission: 'devices.read' },
  { toolName: 'get_log_trends', limit: 20, windowSeconds: 300, tier: 1, permission: 'devices.read' },
  { toolName: 'detect_log_correlations', limit: 10, windowSeconds: 300, tier: 2, permission: 'devices.read' },
  { toolName: 'set_agent_log_level', limit: 5, windowSeconds: 600, tier: 2, permission: 'devices.execute' },
  // Brain device context
  { toolName: 'set_device_context', limit: 20, windowSeconds: 300, tier: 2, permission: 'devices.write' },
  { toolName: 'resolve_device_context', limit: 20, windowSeconds: 300, tier: 2, permission: 'devices.write' },
  // Configuration policies
  { toolName: 'get_configuration_policy', limit: 30, windowSeconds: 300, tier: 1, permission: 'policies.read' },
  { toolName: 'manage_configuration_policy', limit: 20, windowSeconds: 300, tier: 1, permission: 'policies.write' },
  { toolName: 'configuration_policy_compliance', limit: 30, windowSeconds: 300, tier: 1, permission: 'policies.read' },
  { toolName: 'apply_configuration_policy', limit: 10, windowSeconds: 300, tier: 2, permission: 'policies.write' },
  { toolName: 'remove_configuration_policy_assignment', limit: 10, windowSeconds: 300, tier: 2, permission: 'policies.write' },
  // Playbooks
  { toolName: 'execute_playbook', limit: 5, windowSeconds: 600, tier: 3, permission: 'devices.execute' },
  // Fleet tools
  { toolName: 'manage_deployments', limit: 10, windowSeconds: 600, tier: 1, permission: 'deployments.write' },
  { toolName: 'manage_patches', limit: 15, windowSeconds: 300, tier: 1, permission: 'patches.read' },
  { toolName: 'manage_groups', limit: 20, windowSeconds: 300, tier: 1, permission: 'groups.write' },
  { toolName: 'manage_maintenance_windows', limit: 15, windowSeconds: 300, tier: 1, permission: 'maintenance.write' },
  { toolName: 'manage_automations', limit: 10, windowSeconds: 600, tier: 1, permission: 'automations.write' },
  { toolName: 'manage_alert_rules', limit: 15, windowSeconds: 300, tier: 1, permission: 'alerts.write' },
  { toolName: 'generate_report', limit: 10, windowSeconds: 300, tier: 1, permission: 'reports.write' },
];

export const RBAC_MAPPINGS: Record<string, string | Record<string, string>> = {
  // Device & metrics
  query_devices: 'devices.read',
  get_device_details: 'devices.read',
  analyze_metrics: 'devices.read',
  get_active_users: 'devices.read',
  get_user_experience_metrics: 'devices.read',
  get_fleet_health: 'devices.read',
  analyze_boot_performance: 'devices.read',
  analyze_disk_usage: 'devices.read',
  // Network
  get_network_changes: 'devices.read',
  get_ip_history: 'devices.read',
  get_dns_security: 'devices.read',
  acknowledge_network_device: 'devices.write',
  configure_network_baseline: 'devices.write',
  manage_dns_policy: 'devices.write',
  // Commands
  execute_command: 'devices.execute',
  run_script: 'scripts.execute',
  computer_control: 'devices.execute',
  // Alerts
  manage_alerts: {
    list: 'alerts.read',
    get: 'alerts.read',
    acknowledge: 'alerts.acknowledge',
    resolve: 'alerts.write',
  },
  // Services & startup
  manage_services: 'devices.execute',
  manage_startup_items: 'devices.execute',
  // Security
  security_scan: 'devices.execute',
  get_security_posture: 'devices.read',
  // Files & disk
  disk_cleanup: { preview: 'devices.read', execute: 'devices.execute' },
  file_operations: { list: 'devices.read', read: 'devices.read', write: 'devices.execute', delete: 'devices.execute', mkdir: 'devices.execute', rename: 'devices.execute' },
  // Audit & logs
  query_audit_log: 'audit.read',
  query_change_log: 'devices.read',
  search_logs: 'devices.read',
  get_log_trends: 'devices.read',
  detect_log_correlations: 'devices.read',
  search_agent_logs: 'devices.read',
  set_agent_log_level: 'devices.execute',
  // Screenshots
  take_screenshot: 'devices.execute',
  analyze_screen: 'devices.execute',
  // Network discovery
  network_discovery: 'devices.execute',
  // Brain device context
  get_device_context: 'devices.read',
  set_device_context: 'devices.write',
  resolve_device_context: 'devices.write',
  // Software & playbooks
  list_playbooks: 'devices.read',
  execute_playbook: 'devices.execute',
  get_playbook_history: 'devices.read',
  get_software_compliance: 'devices.read',
  manage_software_policy: 'devices.execute',
  remediate_software_violation: 'devices.execute',
  // Configuration policies
  list_configuration_policies: 'policies.read',
  get_configuration_policy: 'policies.read',
  get_effective_configuration: 'devices.read',
  preview_configuration_change: 'devices.read',
  configuration_policy_compliance: { summary: 'policies.read', status: 'policies.read' },
  manage_configuration_policy: {
    create: 'policies.write',
    update: 'policies.write',
    activate: 'policies.write',
    deactivate: 'policies.write',
    delete: 'policies.write',
  },
  apply_configuration_policy: 'policies.write',
  remove_configuration_policy_assignment: 'policies.write',
  // Fleet tools
  manage_deployments: {
    list: 'deployments.read',
    get: 'deployments.read',
    device_status: 'deployments.read',
    create: 'deployments.write',
    start: 'deployments.write',
    pause: 'deployments.write',
    resume: 'deployments.write',
    cancel: 'deployments.write',
  },
  manage_patches: {
    list: 'patches.read',
    compliance: 'patches.read',
    scan: 'patches.execute',
    approve: 'patches.approve',
    decline: 'patches.approve',
    defer: 'patches.approve',
    bulk_approve: 'patches.approve',
    install: 'patches.execute',
    rollback: 'patches.execute',
  },
  manage_groups: {
    list: 'groups.read',
    get: 'groups.read',
    preview: 'groups.read',
    membership_log: 'groups.read',
    create: 'groups.write',
    update: 'groups.write',
    delete: 'groups.write',
    add_devices: 'groups.write',
    remove_devices: 'groups.write',
  },
  manage_maintenance_windows: {
    list: 'maintenance.read',
    get: 'maintenance.read',
    active_now: 'maintenance.read',
    create: 'maintenance.write',
    update: 'maintenance.write',
    delete: 'maintenance.write',
  },
  manage_automations: {
    list: 'automations.read',
    get: 'automations.read',
    history: 'automations.read',
    create: 'automations.write',
    update: 'automations.write',
    delete: 'automations.write',
    enable: 'automations.write',
    disable: 'automations.write',
    run: 'automations.execute',
  },
  manage_alert_rules: {
    list_rules: 'alerts.read',
    get_rule: 'alerts.read',
    create_rule: 'alerts.write',
    update_rule: 'alerts.write',
    delete_rule: 'alerts.write',
    test_rule: 'alerts.read',
    list_channels: 'alerts.read',
    alert_summary: 'alerts.read',
  },
  generate_report: {
    list: 'reports.read',
    generate: 'reports.write',
    data: 'reports.read',
    create: 'reports.write',
    update: 'reports.write',
    delete: 'reports.write',
    history: 'reports.read',
  },
};
