/**
 * AI Tool Input Schemas
 *
 * Zod schemas for validating tool inputs before execution.
 * Provides defense-in-depth against malformed or malicious inputs
 * from the AI model.
 */

import { z } from 'zod';

// Reusable validators
const uuid = z.string().uuid();
const deviceId = z.object({ deviceId: uuid });

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

function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')      // Normalize backslashes
    .replace(/\/+/g, '/')     // Collapse redundant separators (/etc///shadow → /etc/shadow)
    .replace(/\/\.\//g, '/')  // Remove dot components (/etc/./shadow → /etc/shadow)
    .replace(/\/\.$/, '/')    // Trailing dot component
    .toLowerCase();
}

function isBlockedPath(path: string): boolean {
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

const safePath = z.string().max(4096).refine(
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

  create_automation: z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    trigger: z.record(z.unknown()),
    conditions: z.record(z.unknown()).optional(),
    actions: z.array(z.record(z.unknown())).min(1).max(20),
    enabled: z.boolean().optional(),
  }),

  network_discovery: z.object({
    deviceId: uuid,
    subnet: z.string().max(50).regex(
      /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/,
      'Invalid CIDR notation'
    ).optional(),
    scanType: z.enum(['ping', 'arp', 'full']).optional(),
  }),
};

/**
 * Validate tool input against the registered schema.
 * Returns null on success, or an error message on failure.
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
