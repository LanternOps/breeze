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
      { name: 'manage_processes (list)', description: 'List running processes with CPU/memory' },
      // Network
      { name: 'get_network_changes', description: 'Network change detection' },
      { name: 'get_ip_history', description: 'IP address history' },
      { name: 'get_dns_security', description: 'DNS security analysis' },
      // Alerts & security
      { name: 'manage_alerts (list/get)', description: 'View alerts' },
      { name: 'get_security_posture', description: 'Security posture scores' },
      { name: 'security_scan (vulnerabilities)', description: 'Query vulnerability data' },
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
      // Scripts
      { name: 'search_script_library', description: 'Search scripts and templates' },
      { name: 'get_script_details', description: 'Script content, versions, and stats' },
      // Custom fields & tags
      { name: 'query_custom_fields', description: 'Custom field definitions and values' },
      { name: 'manage_tags (list)', description: 'List all device tags' },
      // Registry (read)
      { name: 'registry_operations (read_key/get_value)', description: 'Read Windows registry' },
      // Scheduled tasks (read)
      { name: 'manage_scheduled_tasks (list)', description: 'List Windows scheduled tasks' },
      // Configuration policies
      { name: 'list_configuration_policies', description: 'List config policies' },
      { name: 'get_configuration_policy', description: 'Get config policy details' },
      { name: 'get_effective_configuration', description: 'Effective config resolution' },
      { name: 'preview_configuration_change', description: 'Preview config impact' },
      { name: 'configuration_policy_compliance', description: 'Policy compliance status' },
      // Backup & DR (read)
      { name: 'query_backups', description: 'List backup configs, jobs, and policies' },
      { name: 'get_backup_status', description: 'Backup health summary' },
      { name: 'browse_snapshots', description: 'Browse backup snapshots' },
      // Monitoring (read)
      { name: 'query_monitors', description: 'List monitors with status' },
      { name: 'manage_monitors (get)', description: 'Monitor details and history' },
      // Analytics
      { name: 'query_analytics', description: 'SLA compliance and capacity predictions' },
      { name: 'get_executive_summary', description: 'Executive summary metrics' },
      // Integrations (read)
      { name: 'query_webhooks', description: 'List webhooks and delivery status' },
      { name: 'query_psa_status', description: 'PSA connection status' },
      // Agent management
      { name: 'query_agent_versions', description: 'Agent versions and upgrade status' },
      // Remote sessions (read)
      { name: 'list_remote_sessions', description: 'List remote sessions' },
      // Compliance policies
      { name: 'query_compliance_policies', description: 'List compliance policies' },
      { name: 'get_compliance_status', description: 'Device-level compliance status' },
      // Notification channels (read)
      { name: 'manage_notification_channels (list)', description: 'List notification channels' },
      // Saved filters (read)
      { name: 'manage_saved_filters (list/get)', description: 'List and view saved filters' },
      // Fleet tools (read actions)
      { name: 'manage_deployments (list/get)', description: 'View deployments' },
      { name: 'manage_patches (list/compliance)', description: 'View patches and compliance' },
      { name: 'manage_groups (list/get/preview)', description: 'View device groups' },
      { name: 'manage_maintenance_windows (list/get)', description: 'View maintenance windows' },
      { name: 'manage_automations (list/get/history)', description: 'View automations' },
      { name: 'manage_alert_rules (list/get/test)', description: 'View alert rules' },
      { name: 'generate_report (list/data/history/download)', description: 'View and download reports' },
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
      { name: 'manage_alerts (suppress)', description: 'Suppress alerts temporarily' },
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
      // Tags
      { name: 'manage_tags (add/remove)', description: 'Add or remove device tags' },
      // Logs
      { name: 'detect_log_correlations', description: 'Log correlation detection' },
      { name: 'set_agent_log_level', description: 'Set agent log level' },
      // Configuration policies
      { name: 'apply_configuration_policy', description: 'Assign config policy' },
      { name: 'remove_configuration_policy_assignment', description: 'Remove config assignment' },
      { name: 'manage_configuration_policy (activate/deactivate)', description: 'Toggle policy status' },
      // Integrations
      { name: 'test_webhook', description: 'Test webhook delivery' },
      // Notification channels
      { name: 'manage_notification_channels (test)', description: 'Test notification channel' },
      // Saved filters
      { name: 'manage_saved_filters (create/delete)', description: 'Create or delete saved filters' },
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
      { name: 'manage_processes (kill)', description: 'Terminate a running process' },
      // Services & startup
      { name: 'manage_services (start/stop/restart)', description: 'Mutate device services' },
      { name: 'manage_startup_items (enable/disable)', description: 'Manage startup items' },
      { name: 'manage_scheduled_tasks (run/disable/enable/delete)', description: 'Mutate scheduled tasks' },
      // Security
      { name: 'security_scan (quarantine/remove/restore)', description: 'Threat management actions' },
      // Files & disk
      { name: 'file_operations (write/delete/mkdir/rename)', description: 'Mutate files on device' },
      { name: 'disk_cleanup (execute)', description: 'Execute disk cleanup' },
      // Registry (write)
      { name: 'registry_operations (set/create/delete)', description: 'Modify Windows registry' },
      // Network
      { name: 'network_discovery', description: 'Network discovery scan' },
      // Playbooks & software
      { name: 'execute_playbook', description: 'Execute self-healing playbook' },
      { name: 'manage_software_policy', description: 'Software policy management' },
      { name: 'remediate_software_violation', description: 'Remediate software violations' },
      // Backup & DR (write)
      { name: 'trigger_backup', description: 'Initiate on-demand backup' },
      { name: 'restore_snapshot', description: 'Restore a backup snapshot' },
      // Monitoring (write)
      { name: 'manage_monitors (create/update/delete)', description: 'Create, update, or delete monitors' },
      // Agent management
      { name: 'trigger_agent_upgrade', description: 'Queue agent upgrade' },
      // Remote sessions (write)
      { name: 'create_remote_session', description: 'Create remote terminal or file session' },
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
  { toolName: 'manage_processes', limit: 15, windowSeconds: 300, tier: 1, permission: 'devices.read' },
  // Services & startup
  { toolName: 'manage_services', limit: 10, windowSeconds: 300, tier: 3, permission: 'devices.execute' },
  { toolName: 'manage_startup_items', limit: 5, windowSeconds: 600, tier: 3, permission: 'devices.execute' },
  { toolName: 'manage_scheduled_tasks', limit: 10, windowSeconds: 300, tier: 1, permission: 'devices.read' },
  // Security
  { toolName: 'security_scan', limit: 3, windowSeconds: 600, tier: 3, permission: 'devices.execute' },
  // Files & disk
  { toolName: 'file_operations', limit: 20, windowSeconds: 300, tier: 3, permission: 'devices.execute' },
  { toolName: 'analyze_disk_usage', limit: 10, windowSeconds: 300, tier: 1, permission: 'devices.read' },
  { toolName: 'disk_cleanup', limit: 3, windowSeconds: 600, tier: 3, permission: 'devices.execute' },
  // Registry
  { toolName: 'registry_operations', limit: 15, windowSeconds: 300, tier: 1, permission: 'devices.read' },
  // Network
  { toolName: 'network_discovery', limit: 2, windowSeconds: 600, tier: 3, permission: 'devices.execute' },
  // Screenshots
  { toolName: 'take_screenshot', limit: 10, windowSeconds: 300, tier: 2, permission: 'devices.execute' },
  { toolName: 'analyze_screen', limit: 10, windowSeconds: 300, tier: 2, permission: 'devices.execute' },
  // Tags
  { toolName: 'manage_tags', limit: 20, windowSeconds: 300, tier: 2, permission: 'devices.write' },
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
  // Backup & DR
  { toolName: 'trigger_backup', limit: 5, windowSeconds: 600, tier: 3, permission: 'devices.execute' },
  { toolName: 'restore_snapshot', limit: 3, windowSeconds: 600, tier: 3, permission: 'devices.execute' },
  // Monitoring
  { toolName: 'manage_monitors', limit: 10, windowSeconds: 300, tier: 1, permission: 'devices.write' },
  // Integrations
  { toolName: 'test_webhook', limit: 5, windowSeconds: 300, tier: 2, permission: 'devices.write' },
  // Agent management
  { toolName: 'trigger_agent_upgrade', limit: 5, windowSeconds: 600, tier: 3, permission: 'devices.execute' },
  // Remote sessions
  { toolName: 'create_remote_session', limit: 10, windowSeconds: 300, tier: 3, permission: 'devices.execute' },
  // Notification channels & saved filters
  { toolName: 'manage_notification_channels', limit: 10, windowSeconds: 300, tier: 1, permission: 'alerts.read' },
  { toolName: 'manage_saved_filters', limit: 15, windowSeconds: 300, tier: 1, permission: 'devices.read' },
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
  manage_processes: { list: 'devices.read', kill: 'devices.execute' },
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
    suppress: 'alerts.write',
  },
  // Services & startup
  manage_services: 'devices.execute',
  manage_startup_items: 'devices.execute',
  manage_scheduled_tasks: { list: 'devices.read', run: 'devices.execute', disable: 'devices.execute', enable: 'devices.execute', delete: 'devices.execute' },
  // Security
  security_scan: { scan: 'devices.execute', status: 'devices.execute', quarantine: 'devices.execute', remove: 'devices.execute', restore: 'devices.execute', vulnerabilities: 'devices.read' },
  get_security_posture: 'devices.read',
  // Files & disk
  disk_cleanup: { preview: 'devices.read', execute: 'devices.execute' },
  file_operations: { list: 'devices.read', read: 'devices.read', write: 'devices.execute', delete: 'devices.execute', mkdir: 'devices.execute', rename: 'devices.execute' },
  // Registry
  registry_operations: { read_key: 'devices.read', get_value: 'devices.read', set_value: 'devices.execute', create_key: 'devices.execute', delete_key: 'devices.execute' },
  // Tags & custom fields
  manage_tags: { list: 'devices.read', add: 'devices.write', remove: 'devices.write' },
  query_custom_fields: 'devices.read',
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
  // Scripts
  search_script_library: 'scripts.read',
  get_script_details: 'scripts.read',
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
  // Backup & DR
  query_backups: 'devices.read',
  get_backup_status: 'devices.read',
  browse_snapshots: 'devices.read',
  trigger_backup: 'devices.execute',
  restore_snapshot: 'devices.execute',
  // Monitoring
  query_monitors: 'devices.read',
  manage_monitors: { get: 'devices.read', create: 'devices.write', update: 'devices.write', delete: 'devices.write' },
  // Analytics
  query_analytics: 'devices.read',
  get_executive_summary: 'devices.read',
  // Integrations
  query_webhooks: 'devices.read',
  query_psa_status: 'devices.read',
  test_webhook: 'devices.write',
  // Agent management
  query_agent_versions: 'devices.read',
  trigger_agent_upgrade: 'devices.execute',
  // Remote sessions
  list_remote_sessions: 'devices.read',
  create_remote_session: 'devices.execute',
  // Compliance policies
  query_compliance_policies: 'policies.read',
  get_compliance_status: 'policies.read',
  // Notification channels
  manage_notification_channels: { list: 'alerts.read', test: 'alerts.write' },
  // Saved filters
  manage_saved_filters: { list: 'devices.read', get: 'devices.read', create: 'devices.write', delete: 'devices.write' },
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
    download: 'reports.read',
  },
};
