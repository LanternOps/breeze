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
      { name: 'query_devices', description: 'Search and filter devices' },
      { name: 'get_device_details', description: 'Get comprehensive device info' },
      { name: 'analyze_metrics', description: 'Time-series metrics analysis' },
      { name: 'get_active_users', description: 'Active user sessions' },
      { name: 'get_user_experience_metrics', description: 'Login performance and session trends' },
      { name: 'manage_alerts (list/get)', description: 'View alerts' },
      { name: 'get_security_posture', description: 'Security posture scores' },
      { name: 'query_audit_log', description: 'Search audit logs' },
      { name: 'analyze_disk_usage', description: 'Filesystem analysis' },
      { name: 'file_operations (list/read)', description: 'List and read files' },
      { name: 'disk_cleanup (preview)', description: 'Preview cleanup candidates' },
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
      { name: 'manage_alerts (acknowledge)', description: 'Acknowledge alerts' },
      { name: 'manage_alerts (resolve)', description: 'Resolve alerts' },
      { name: 'manage_services (list)', description: 'List services on device' },
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
      { name: 'execute_command', description: 'Execute system commands on device' },
      { name: 'run_script', description: 'Run scripts on up to 10 devices' },
      { name: 'manage_services (start/stop/restart)', description: 'Mutate device services' },
      { name: 'security_scan (quarantine/remove/restore)', description: 'Threat management actions' },
      { name: 'file_operations (write/delete/mkdir/rename)', description: 'Mutate files on device' },
      { name: 'disk_cleanup (execute)', description: 'Execute disk cleanup' },
      { name: 'create_automation', description: 'Create automation rules' },
      { name: 'network_discovery', description: 'Network discovery scan' },
    ],
  },
  {
    tier: 4,
    label: 'Blocked',
    description: 'Operations that are never allowed, such as cross-organization data access.',
    icon: ShieldOff,
    borderColor: 'border-l-red-500',
    badgeBg: 'bg-red-500/15',
    badgeText: 'text-red-700',
    tools: [
      { name: 'Cross-org access', description: 'Any operation targeting resources outside the current organization' },
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
  { toolName: 'execute_command', limit: 10, windowSeconds: 300, tier: 3, permission: 'devices.execute' },
  { toolName: 'run_script', limit: 5, windowSeconds: 300, tier: 3, permission: 'scripts.execute' },
  { toolName: 'security_scan', limit: 3, windowSeconds: 600, tier: 3, permission: 'devices.execute' },
  { toolName: 'network_discovery', limit: 2, windowSeconds: 600, tier: 3, permission: 'devices.execute' },
  { toolName: 'create_automation', limit: 5, windowSeconds: 600, tier: 3, permission: 'automations.write' },
  { toolName: 'file_operations', limit: 20, windowSeconds: 300, tier: 3, permission: 'devices.execute' },
  { toolName: 'manage_services', limit: 10, windowSeconds: 300, tier: 3, permission: 'devices.execute' },
  { toolName: 'analyze_disk_usage', limit: 10, windowSeconds: 300, tier: 1, permission: 'devices.read' },
  { toolName: 'disk_cleanup', limit: 3, windowSeconds: 600, tier: 3, permission: 'devices.execute' },
];

export const RBAC_MAPPINGS: Record<string, string | Record<string, string>> = {
  query_devices: 'devices.read',
  get_device_details: 'devices.read',
  analyze_metrics: 'devices.read',
  execute_command: 'devices.execute',
  run_script: 'scripts.execute',
  manage_alerts: {
    list: 'alerts.read',
    get: 'alerts.read',
    acknowledge: 'alerts.acknowledge',
    resolve: 'alerts.write',
  },
  manage_services: 'devices.execute',
  security_scan: 'devices.execute',
  analyze_disk_usage: 'devices.read',
  disk_cleanup: { preview: 'devices.read', execute: 'devices.execute' },
  file_operations: { list: 'devices.read', read: 'devices.read', write: 'devices.execute', delete: 'devices.execute', mkdir: 'devices.execute', rename: 'devices.execute' },
  query_audit_log: 'audit.read',
  create_automation: 'automations.write',
  network_discovery: 'devices.execute',
  get_security_posture: 'devices.read',
  get_active_users: 'devices.read',
  get_user_experience_metrics: 'devices.read',
};
