/**
 * AI Tool Input Schemas
 *
 * Zod schemas for validating tool inputs before execution.
 * Provides defense-in-depth against malformed or malicious inputs
 * from the AI model.
 */

import { z } from 'zod';
import { isIP } from 'node:net';
import { fleetToolInputSchemas } from './aiToolSchemasFleet';

// Reusable validators
const uuid = z.string().uuid();
const deviceId = z.object({ deviceId: uuid });
const ipAddress = z.string().trim().max(45).refine(
  (value) => {
    const withoutZone = value.includes('%') ? value.slice(0, Math.max(value.indexOf('%'), 0)) : value;
    return isIP(withoutZone) !== 0;
  },
  { message: 'Invalid IP address format' }
);

// Path traversal defense
const BLOCKED_PATH_PREFIXES = [
  '/etc/shadow', '/etc/passwd', '/etc/sudoers',
  '/proc', '/sys', '/dev',
  '/root/.ssh', '/home/*/.ssh',
  '/var/run', '/var/lib/docker',
  'C:\\Windows\\System32\\config',
  'C:\\Windows\\SAM',
  'C:\\Users\\*\\AppData',
];

export function normalizePath(path: string): string {
  let result = path
    .replace(/\\/g, '/')      // Normalize backslashes
    .replace(/\/+/g, '/')     // Collapse redundant separators (/etc///shadow → /etc/shadow)
    .toLowerCase();
  // Iteratively remove dot components until stable
  let prev: string;
  do {
    prev = result;
    result = result.replace(/\/\.\//g, '/').replace(/\/\.$/, '/');
  } while (result !== prev);
  return result;
}

export function isBlockedPath(path: string): boolean {
  if (path.includes('..')) return true;
  const normalized = normalizePath(path);
  return BLOCKED_PATH_PREFIXES.some(prefix => {
    const normalizedPrefix = normalizePath(prefix);
    // Handle wildcard prefixes like /home/*/.ssh
    if (normalizedPrefix.includes('*')) {
      const parts = normalizedPrefix.split('*');
      return parts.length === 2 &&
        normalized.startsWith(parts[0]!) &&
        normalized.includes(parts[1]!);
    }
    return normalized.startsWith(normalizedPrefix) ||
      normalized === normalizedPrefix.replace(/\/$/, '');
  });
}

export const safePath = z.string().max(4096).refine(
  (path) => !path.includes('\0'),
  { message: 'Path contains null bytes' }
).refine(
  (path) => !path.includes('..'),
  { message: 'Path traversal (..) not allowed' }
).refine(
  (path) => !isBlockedPath(path),
  { message: 'Access to this path is blocked' }
);

const cleanupPath = z.string().max(4096).refine(
  (path) => !path.includes('\0'),
  { message: 'Path contains null bytes' }
).refine(
  (path) => !path.includes('..'),
  { message: 'Path traversal (..) not allowed' }
);

// Tool schemas
export const toolInputSchemas: Record<string, z.ZodType> = {
  query_devices: z.object({
    status: z.enum(['online', 'offline', 'maintenance', 'decommissioned']).optional(),
    osType: z.enum(['windows', 'macos', 'linux']).optional(),
    siteId: uuid.optional(),
    search: z.string().max(200).optional(),
    tags: z.array(z.string().max(100)).max(20).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  get_device_details: z.object({
    deviceId: uuid,
  }),

  get_ip_history: z.object({
    device_id: uuid.optional(),
    ip_address: ipAddress.optional(),
    at_time: z.string().datetime({ offset: true }).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    interface_name: z.string().max(100).optional(),
    assignment_type: z.enum(['dhcp', 'static', 'vpn', 'link-local', 'unknown']).optional(),
    active_only: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }).refine(
    (data) => Boolean(data.device_id || data.ip_address),
    { message: 'Either device_id or ip_address must be provided' }
  ).refine(
    (data) => !data.ip_address || Boolean(data.at_time),
    { message: 'at_time is required when ip_address is provided' }
  ),

  analyze_metrics: z.object({
    deviceId: uuid,
    metric: z.enum(['cpu', 'ram', 'disk', 'network', 'all']).optional(),
    hoursBack: z.number().int().min(1).max(168).optional(),
    aggregation: z.enum(['raw', 'hourly', 'daily']).optional(),
  }),

  get_active_users: z.object({
    deviceId: uuid.optional(),
    limit: z.number().int().min(1).max(200).optional(),
    idleThresholdMinutes: z.number().int().min(1).max(1440).optional(),
  }),

  get_user_experience_metrics: z.object({
    deviceId: uuid.optional(),
    username: z.string().max(255).optional(),
    daysBack: z.number().int().min(1).max(365).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),

  manage_alerts: z.object({
    action: z.enum(['list', 'get', 'acknowledge', 'resolve']),
    alertId: uuid.optional(),
    status: z.enum(['active', 'acknowledged', 'resolved', 'suppressed']).optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
    deviceId: uuid.optional(),
    limit: z.number().int().min(1).max(100).optional(),
    resolutionNote: z.string().max(1000).optional(),
  }).refine(
    (data) => {
      if (['get', 'acknowledge', 'resolve'].includes(data.action) && !data.alertId) {
        return false;
      }
      return true;
    },
    { message: 'alertId is required for get/acknowledge/resolve actions' }
  ),

  execute_command: z.object({
    deviceId: uuid,
    commandType: z.enum([
      'list_processes', 'kill_process',
      'list_services', 'start_service', 'stop_service', 'restart_service',
      'file_list', 'file_read',
      'event_logs_list', 'event_logs_query',
    ]),
    payload: z.record(z.unknown()).optional(),
  }),

  run_script: z.object({
    scriptId: uuid,
    deviceIds: z.array(uuid).min(1).max(10),
    parameters: z.record(z.unknown()).optional(),
  }),

  manage_services: z.object({
    deviceId: uuid,
    action: z.enum(['list', 'start', 'stop', 'restart']),
    serviceName: z.string().max(255).optional(),
  }).refine(
    (data) => {
      if (['start', 'stop', 'restart'].includes(data.action) && !data.serviceName) {
        return false;
      }
      return true;
    },
    { message: 'serviceName is required for start/stop/restart actions' }
  ),

  security_scan: z.object({
    deviceId: uuid,
    action: z.enum(['scan', 'status', 'quarantine', 'remove', 'restore']),
    threatId: z.string().max(255).optional(),
  }).refine(
    (data) => {
      if (['quarantine', 'remove', 'restore'].includes(data.action) && !data.threatId) {
        return false;
      }
      return true;
    },
    { message: 'threatId is required for quarantine/remove/restore actions' }
  ),

  get_security_posture: z.object({
    deviceId: uuid.optional(),
    orgId: uuid.optional(),
    minScore: z.number().int().min(0).max(100).optional(),
    maxScore: z.number().int().min(0).max(100).optional(),
    riskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    includeRecommendations: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional()
  }),

  get_fleet_health: z.object({
    orgId: uuid.optional(),
    siteId: uuid.optional(),
    scoreRange: z.enum(['critical', 'poor', 'fair', 'good']).optional(),
    trendDirection: z.enum(['improving', 'stable', 'degrading']).optional(),
    issueType: z.enum(['crashes', 'hangs', 'hardware', 'services', 'uptime']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  file_operations: z.object({
    deviceId: uuid,
    action: z.enum(['list', 'read', 'write', 'delete', 'mkdir', 'rename']),
    path: safePath,
    content: z.string().max(1_000_000).optional(),
    newPath: safePath.optional(),
  }),

  analyze_disk_usage: z.object({
    deviceId: uuid,
    refresh: z.boolean().optional(),
    path: safePath.optional(),
    maxDepth: z.number().int().min(1).max(64).optional(),
    topFiles: z.number().int().min(1).max(500).optional(),
    topDirs: z.number().int().min(1).max(200).optional(),
    maxEntries: z.number().int().min(1_000).max(25_000_000).optional(),
    workers: z.number().int().min(1).max(32).optional(),
    timeoutSeconds: z.number().int().min(5).max(900).optional(),
    maxCandidates: z.number().int().min(1).max(200).optional(),
  }),

  disk_cleanup: z.object({
    deviceId: uuid,
    action: z.enum(['preview', 'execute']),
    categories: z.array(z.enum(['temp_files', 'browser_cache', 'package_cache', 'trash'])).max(10).optional(),
    paths: z.array(cleanupPath).min(1).max(200).optional(),
    maxCandidates: z.number().int().min(1).max(200).optional(),
  }).refine(
    (data) => data.action === 'preview' || (data.action === 'execute' && Array.isArray(data.paths) && data.paths.length > 0),
    { message: 'paths are required for execute action' }
  ),

  query_audit_log: z.object({
    action: z.string().max(100).optional(),
    resourceType: z.string().max(100).optional(),
    resourceId: uuid.optional(),
    actorType: z.enum(['user', 'api_key', 'agent', 'system']).optional(),
    hoursBack: z.number().int().min(1).max(168).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  get_network_changes: z.object({
    org_id: uuid.optional(),
    site_id: uuid.optional(),
    baseline_id: uuid.optional(),
    event_type: z.enum(['new_device', 'device_disappeared', 'device_changed', 'rogue_device']).optional(),
    acknowledged: z.boolean().optional(),
    since: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),

  acknowledge_network_device: z.object({
    event_id: uuid,
    notes: z.string().max(2000).optional(),
  }),

  configure_network_baseline: z.object({
    baseline_id: uuid.optional(),
    org_id: uuid.optional(),
    site_id: uuid.optional(),
    subnet: z.string().regex(/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/).optional(),
    scan_interval_hours: z.number().int().min(1).max(168).optional(),
    alert_on_new_device: z.boolean().optional(),
    alert_on_disappeared: z.boolean().optional(),
    alert_on_changed: z.boolean().optional(),
    alert_on_rogue_device: z.boolean().optional(),
  }),

  query_change_log: z.object({
    deviceId: uuid.optional(),
    startTime: z.string().datetime({ offset: true }).optional(),
    endTime: z.string().datetime({ offset: true }).optional(),
    changeType: z.enum(['software', 'service', 'startup', 'network', 'scheduled_task', 'user_account']).optional(),
    changeAction: z.enum(['added', 'removed', 'modified', 'updated']).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),

  network_discovery: z.object({
    deviceId: uuid,
    subnet: z.string().max(50).regex(
      /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/,
      'Invalid CIDR notation'
    ).optional(),
    scanType: z.enum(['ping', 'arp', 'full']).optional(),
  }),

  take_screenshot: deviceId.extend({
    monitor: z.number().int().min(0).max(10).optional(),
  }),

  analyze_screen: deviceId.extend({
    context: z.string().max(500).optional(),
    monitor: z.number().int().min(0).max(10).optional(),
  }),

  // Brain device context tools
  get_device_context: z.object({
    deviceId: uuid,
    includeResolved: z.boolean().optional().default(false),
  }),

  set_device_context: z.object({
    deviceId: uuid,
    contextType: z.enum(['issue', 'quirk', 'followup', 'preference']),
    summary: z.string().min(1).max(255),
    details: z.record(z.unknown()).optional(),
    expiresInDays: z.number().int().positive().max(365).optional(),
  }),

  resolve_device_context: z.object({
    contextId: uuid,
  }),

  // Computer control with conditional field validation
  computer_control: z.object({
    deviceId: uuid,
    action: z.enum([
      'screenshot', 'left_click', 'right_click', 'middle_click',
      'double_click', 'mouse_move', 'scroll', 'key', 'type',
    ]),
    x: z.number().int().min(0).max(10000).optional(),
    y: z.number().int().min(0).max(10000).optional(),
    text: z.string().max(1000).optional(),
    key: z.string().max(50).regex(/^[a-zA-Z0-9_]+$/, 'Invalid key name').optional(),
    modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).max(4).optional(),
    scrollDelta: z.number().int().min(-100).max(100).optional(),
    monitor: z.number().int().min(0).max(10).optional(),
    captureAfter: z.boolean().optional(),
    captureDelayMs: z.number().int().min(0).max(3000).optional(),
  }).superRefine((data, ctx) => {
    const MOUSE_ACTIONS = ['left_click', 'right_click', 'middle_click', 'double_click', 'mouse_move', 'scroll'];
    if (MOUSE_ACTIONS.includes(data.action)) {
      if (data.x === undefined || data.y === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `x and y coordinates are required for ${data.action} action`,
          path: ['x'],
        });
      }
    }
    if (data.action === 'key' && !data.key) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'key field is required for key action',
        path: ['key'],
      });
    }
    if (data.action === 'type' && !data.text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'text field is required for type action',
        path: ['text'],
      });
    }
  }),

  // Boot performance & startup tools
  analyze_boot_performance: z.object({
    deviceId: uuid,
    bootsBack: z.number().int().min(1).max(30).optional(),
    triggerCollection: z.boolean().optional(),
  }),

  manage_startup_items: z.object({
    deviceId: uuid,
    itemName: z.string().min(1).max(255),
    itemId: z.string().max(512).optional(),
    itemType: z.string().max(64).optional(),
    itemPath: z.string().max(2048).optional(),
    action: z.enum(['disable', 'enable']),
    reason: z.string().max(500).optional(),
  }),

  // Software policy tools
  get_software_compliance: z.object({
    policyId: uuid.optional(),
    deviceIds: z.array(uuid).max(500).optional(),
    status: z.enum(['compliant', 'violation', 'unknown']).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),

  manage_software_policy: z.object({
    action: z.enum(['create', 'update', 'delete', 'list', 'get']),
    policyId: uuid.optional(),
    orgId: uuid.optional(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(4000).optional(),
    mode: z.enum(['allowlist', 'blocklist', 'audit']).optional(),
    software: z.array(z.object({
      name: z.string().min(1).max(500),
      vendor: z.string().max(200).optional(),
      minVersion: z.string().max(100).optional(),
      maxVersion: z.string().max(100).optional(),
      catalogId: uuid.optional(),
      reason: z.string().max(1000).optional(),
    })).max(1000).optional(),
    allowUnknown: z.boolean().optional(),
    targetType: z.enum(['organization', 'site', 'device_group', 'devices']).optional(),
    targetIds: z.array(uuid).max(1000).optional(),
    priority: z.number().int().min(0).max(100).optional(),
    enforceMode: z.boolean().optional(),
    isActive: z.boolean().optional(),
    remediationOptions: z.object({
      autoUninstall: z.boolean().optional(),
      notifyUser: z.boolean().optional(),
      gracePeriod: z.number().int().min(0).max(24 * 90).optional(), // hours; max 90 days
      cooldownMinutes: z.number().int().min(1).max(24 * 90 * 60).optional(),
      maintenanceWindowOnly: z.boolean().optional(),
    }).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).refine(
    (data) => !['update', 'delete', 'get'].includes(data.action) || !!data.policyId,
    { message: 'policyId is required for update/delete/get actions' }
  ).refine(
    (data) => data.action !== 'create' || (!!data.name && !!data.mode && !!data.targetType),
    { message: 'name, mode, and targetType are required for create action' }
  ),

  remediate_software_violation: z.object({
    policyId: uuid,
    deviceIds: z.array(uuid).max(500).optional(),
    autoUninstall: z.boolean().optional(),
  }),

  // Agent log tools
  search_agent_logs: z.object({
    deviceIds: z.array(uuid).max(50).optional(),
    level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    component: z.string().max(100).optional(),
    startTime: z.string().datetime({ offset: true }).optional(),
    endTime: z.string().datetime({ offset: true }).optional(),
    message: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),

  set_agent_log_level: z.object({
    deviceId: uuid,
    level: z.enum(['debug', 'info', 'warn', 'error']),
    durationMinutes: z.number().int().min(1).max(1440).optional(),
  }),

  // Event log tools
  search_logs: z.object({
    query: z.string().max(500).optional(),
    timeRange: z.object({
      start: z.string().datetime({ offset: true }),
      end: z.string().datetime({ offset: true }),
    }).optional(),
    level: z.array(z.enum(['info', 'warning', 'error', 'critical'])).max(4).optional(),
    category: z.array(z.enum(['security', 'hardware', 'application', 'system'])).max(4).optional(),
    source: z.string().max(255).optional(),
    deviceIds: z.array(uuid).max(500).optional(),
    siteIds: z.array(uuid).max(500).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
    cursor: z.string().max(1024).optional(),
    countMode: z.enum(['exact', 'estimated', 'none']).optional(),
    sortBy: z.enum(['timestamp', 'level', 'device']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
  }),

  get_log_trends: z.object({
    timeRange: z.object({
      start: z.string().datetime({ offset: true }),
      end: z.string().datetime({ offset: true }),
    }).optional(),
    groupBy: z.enum(['level', 'source', 'device', 'category']).optional(),
    minLevel: z.enum(['info', 'warning', 'error', 'critical']).optional(),
    source: z.string().max(255).optional(),
    deviceIds: z.array(uuid).max(500).optional(),
    siteIds: z.array(uuid).max(500).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  detect_log_correlations: z.object({
    orgId: uuid.optional(),
    pattern: z.string().min(1).max(1000),
    isRegex: z.boolean().optional(),
    timeWindow: z.number().int().min(30).max(86_400).optional(),
    minDevices: z.number().int().min(1).max(200).optional(),
    minOccurrences: z.number().int().min(1).max(50_000).optional(),
  }),

  // Configuration policy tools
  list_configuration_policies: z.object({
    status: z.enum(['active', 'inactive', 'archived']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  get_effective_configuration: z.object({
    deviceId: uuid,
  }),

  preview_configuration_change: z.object({
    deviceId: uuid,
    add: z.array(z.object({
      configPolicyId: uuid,
      level: z.enum(['partner', 'organization', 'site', 'device_group', 'device']),
      targetId: uuid,
      priority: z.number().int().optional(),
    })).optional(),
    remove: z.array(uuid).optional(),
  }),

  apply_configuration_policy: z.object({
    configPolicyId: uuid,
    level: z.enum(['partner', 'organization', 'site', 'device_group', 'device']),
    targetId: uuid,
    priority: z.number().int().min(0).max(1000).optional(),
  }),

  remove_configuration_policy_assignment: z.object({
    assignmentId: uuid,
  }),

  // Playbook tools
  list_playbooks: z.object({
    category: z.enum(['disk', 'service', 'memory', 'patch', 'security', 'all']).optional(),
  }),

  execute_playbook: z.object({
    playbookId: uuid,
    deviceId: uuid,
    variables: z.record(z.unknown()).optional(),
    context: z.record(z.unknown()).optional(),
  }),

  get_playbook_history: z.object({
    deviceId: uuid.optional(),
    playbookId: uuid.optional(),
    status: z.enum(['pending', 'running', 'waiting', 'completed', 'failed', 'rolled_back', 'cancelled']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  // Fleet orchestration tools
  ...fleetToolInputSchemas,
};

/**
 * Validate tool input against the registered schema.
 * Returns { success: true } if valid, or { success: false, error } with details.
 */
export function validateToolInput(
  toolName: string,
  input: Record<string, unknown>
): { success: true } | { success: false; error: string } {
  const schema = toolInputSchemas[toolName];
  if (!schema) {
    console.warn(`[AI] No input schema defined for tool "${toolName}" — input bypasses validation`);
    return { success: true };
  }

  const result = schema.safeParse(input);
  if (result.success) {
    return { success: true };
  }

  const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
  return { success: false, error: `Invalid input: ${issues}` };
}
