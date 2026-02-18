/**
 * AI Guardrails Service
 *
 * Tiered permission system for AI tool execution:
 * - Tier 1: Auto-execute (read-only tools)
 * - Tier 2: Auto-execute + audit (low-risk mutations)
 * - Tier 3: Requires user approval (destructive/mutating operations)
 * - Tier 4: Blocked (auth/user/role modifications, cross-org access)
 *
 * Also enforces RBAC permission checks and per-tool rate limiting.
 */

import { getToolTier } from './aiTools';
import { getUserPermissions, hasPermission } from './permissions';
import { rateLimiter } from './rate-limit';
import { getRedis } from './redis';
import type { AuthContext } from '../middleware/auth';

type AiToolTier = 1 | 2 | 3 | 4;

// Tools that are always blocked (Tier 4)
const BLOCKED_TOOLS = new Set<string>([
  // No tools are explicitly blocked at the tool level —
  // cross-org access is enforced by orgCondition in each handler
]);

// Actions that are Tier 2 (auto-execute + audit):
//   manage_alerts: acknowledge/resolve are low-risk mutations
//   manage_services: list is a read downgraded from the tool's base Tier 3
const TIER2_ACTIONS: Record<string, string[]> = {
  manage_alerts: ['acknowledge', 'resolve'],
  manage_services: ['list'],
  // Fleet tools — Tier 2 actions (auto-execute + audit)
  manage_policies: ['evaluate', 'activate', 'deactivate'],
  manage_deployments: ['pause', 'resume'],
  manage_patches: ['approve', 'decline', 'defer', 'bulk_approve'],
  manage_groups: ['add_devices', 'remove_devices'],
  manage_maintenance_windows: ['create', 'update'],
  manage_automations: ['enable', 'disable'],
  manage_alert_rules: ['create_rule', 'update_rule'],
  generate_report: ['create', 'update', 'delete', 'generate'],
};

// Mutations that require approval (Tier 3) even if the tool is registered as Tier 1
const TIER3_ACTIONS: Record<string, string[]> = {
  file_operations: ['write', 'delete', 'mkdir', 'rename'],
  manage_services: ['start', 'stop', 'restart'],
  security_scan: ['quarantine', 'remove', 'restore'],
  disk_cleanup: ['execute'],
  manage_startup_items: ['disable', 'enable'],
  // Fleet tools — Tier 3 actions (require user approval)
  manage_policies: ['create', 'update', 'delete', 'remediate'],
  manage_deployments: ['create', 'start', 'cancel'],
  manage_patches: ['scan', 'install', 'rollback'],
  manage_groups: ['create', 'update', 'delete'],
  manage_maintenance_windows: ['delete'],
  manage_automations: ['create', 'update', 'delete', 'run'],
  manage_alert_rules: ['delete_rule'],
};

// RBAC permission map: tool → { resource, action } (or action-based overrides)
const TOOL_PERMISSIONS: Record<string, { resource: string; action: string } | Record<string, { resource: string; action: string }>> = {
  query_devices: { resource: 'devices', action: 'read' },
  get_device_details: { resource: 'devices', action: 'read' },
  analyze_metrics: { resource: 'devices', action: 'read' },
  execute_command: { resource: 'devices', action: 'execute' },
  run_script: { resource: 'scripts', action: 'execute' },
  manage_alerts: {
    list: { resource: 'alerts', action: 'read' },
    get: { resource: 'alerts', action: 'read' },
    acknowledge: { resource: 'alerts', action: 'acknowledge' },
    resolve: { resource: 'alerts', action: 'write' },
  },
  manage_services: { resource: 'devices', action: 'execute' },
  security_scan: { resource: 'devices', action: 'execute' },
  analyze_disk_usage: { resource: 'devices', action: 'read' },
  disk_cleanup: {
    preview: { resource: 'devices', action: 'read' },
    execute: { resource: 'devices', action: 'execute' },
  },
  file_operations: {
    list: { resource: 'devices', action: 'read' },
    read: { resource: 'devices', action: 'read' },
    write: { resource: 'devices', action: 'execute' },
    delete: { resource: 'devices', action: 'execute' },
    mkdir: { resource: 'devices', action: 'execute' },
    rename: { resource: 'devices', action: 'execute' },
  },
  query_audit_log: { resource: 'audit', action: 'read' },
  network_discovery: { resource: 'devices', action: 'execute' },
  analyze_boot_performance: { resource: 'devices', action: 'read' },
  manage_startup_items: { resource: 'devices', action: 'execute' },
  take_screenshot: { resource: 'devices', action: 'execute' },
  analyze_screen: { resource: 'devices', action: 'execute' },
  computer_control: { resource: 'devices', action: 'execute' },
  // Fleet tools — RBAC mappings
  manage_policies: {
    list: { resource: 'policies', action: 'read' },
    get: { resource: 'policies', action: 'read' },
    compliance_status: { resource: 'policies', action: 'read' },
    compliance_summary: { resource: 'policies', action: 'read' },
    evaluate: { resource: 'policies', action: 'execute' },
    create: { resource: 'policies', action: 'write' },
    update: { resource: 'policies', action: 'write' },
    activate: { resource: 'policies', action: 'write' },
    deactivate: { resource: 'policies', action: 'write' },
    delete: { resource: 'policies', action: 'write' },
    remediate: { resource: 'policies', action: 'execute' },
  },
  manage_deployments: {
    list: { resource: 'deployments', action: 'read' },
    get: { resource: 'deployments', action: 'read' },
    device_status: { resource: 'deployments', action: 'read' },
    create: { resource: 'deployments', action: 'write' },
    start: { resource: 'deployments', action: 'write' },
    pause: { resource: 'deployments', action: 'write' },
    resume: { resource: 'deployments', action: 'write' },
    cancel: { resource: 'deployments', action: 'write' },
  },
  manage_patches: {
    list: { resource: 'patches', action: 'read' },
    compliance: { resource: 'patches', action: 'read' },
    scan: { resource: 'patches', action: 'execute' },
    approve: { resource: 'patches', action: 'approve' },
    decline: { resource: 'patches', action: 'approve' },
    defer: { resource: 'patches', action: 'approve' },
    bulk_approve: { resource: 'patches', action: 'approve' },
    install: { resource: 'patches', action: 'execute' },
    rollback: { resource: 'patches', action: 'execute' },
  },
  manage_groups: {
    list: { resource: 'groups', action: 'read' },
    get: { resource: 'groups', action: 'read' },
    preview: { resource: 'groups', action: 'read' },
    membership_log: { resource: 'groups', action: 'read' },
    create: { resource: 'groups', action: 'write' },
    update: { resource: 'groups', action: 'write' },
    delete: { resource: 'groups', action: 'write' },
    add_devices: { resource: 'groups', action: 'write' },
    remove_devices: { resource: 'groups', action: 'write' },
  },
  manage_maintenance_windows: {
    list: { resource: 'maintenance', action: 'read' },
    get: { resource: 'maintenance', action: 'read' },
    active_now: { resource: 'maintenance', action: 'read' },
    create: { resource: 'maintenance', action: 'write' },
    update: { resource: 'maintenance', action: 'write' },
    delete: { resource: 'maintenance', action: 'write' },
  },
  manage_automations: {
    list: { resource: 'automations', action: 'read' },
    get: { resource: 'automations', action: 'read' },
    history: { resource: 'automations', action: 'read' },
    create: { resource: 'automations', action: 'write' },
    update: { resource: 'automations', action: 'write' },
    delete: { resource: 'automations', action: 'write' },
    enable: { resource: 'automations', action: 'write' },
    disable: { resource: 'automations', action: 'write' },
    run: { resource: 'automations', action: 'execute' },
  },
  manage_alert_rules: {
    list_rules: { resource: 'alerts', action: 'read' },
    get_rule: { resource: 'alerts', action: 'read' },
    create_rule: { resource: 'alerts', action: 'write' },
    update_rule: { resource: 'alerts', action: 'write' },
    delete_rule: { resource: 'alerts', action: 'write' },
    test_rule: { resource: 'alerts', action: 'read' },
    list_channels: { resource: 'alerts', action: 'read' },
    alert_summary: { resource: 'alerts', action: 'read' },
  },
  generate_report: {
    list: { resource: 'reports', action: 'read' },
    generate: { resource: 'reports', action: 'write' },
    data: { resource: 'reports', action: 'read' },
    create: { resource: 'reports', action: 'write' },
    update: { resource: 'reports', action: 'write' },
    delete: { resource: 'reports', action: 'write' },
    history: { resource: 'reports', action: 'read' },
  },
  // Brain device context tools
  get_device_context: { resource: 'devices', action: 'read' },
  set_device_context: { resource: 'devices', action: 'write' },
  resolve_device_context: { resource: 'devices', action: 'write' },
  // Agent log tools
  search_agent_logs: { resource: 'devices', action: 'read' },
  set_agent_log_level: { resource: 'devices', action: 'execute' },
  // Configuration policy tools
  list_configuration_policies: { resource: 'policies', action: 'read' },
  get_effective_configuration: { resource: 'devices', action: 'read' },
  preview_configuration_change: { resource: 'devices', action: 'read' },
  apply_configuration_policy: { resource: 'policies', action: 'write' },
  remove_configuration_policy_assignment: { resource: 'policies', action: 'write' },
};

// Per-tool rate limits: { limit, windowSeconds }
const TOOL_RATE_LIMITS: Record<string, { limit: number; windowSeconds: number }> = {
  execute_command: { limit: 10, windowSeconds: 300 },
  run_script: { limit: 5, windowSeconds: 300 },
  security_scan: { limit: 3, windowSeconds: 600 },
  network_discovery: { limit: 2, windowSeconds: 600 },
  file_operations: { limit: 20, windowSeconds: 300 },
  manage_services: { limit: 10, windowSeconds: 300 },
  analyze_disk_usage: { limit: 10, windowSeconds: 300 },
  disk_cleanup: { limit: 3, windowSeconds: 600 },
  manage_startup_items: { limit: 5, windowSeconds: 600 },
  take_screenshot: { limit: 10, windowSeconds: 300 },
  analyze_screen: { limit: 10, windowSeconds: 300 },
  computer_control: { limit: 20, windowSeconds: 300 },
  // Fleet tools — per-tool rate limits
  manage_policies: { limit: 20, windowSeconds: 300 },
  manage_deployments: { limit: 10, windowSeconds: 600 },
  manage_patches: { limit: 15, windowSeconds: 300 },
  manage_groups: { limit: 20, windowSeconds: 300 },
  manage_maintenance_windows: { limit: 15, windowSeconds: 300 },
  manage_automations: { limit: 10, windowSeconds: 600 },
  manage_alert_rules: { limit: 15, windowSeconds: 300 },
  generate_report: { limit: 10, windowSeconds: 300 },
  // Brain device context tools
  set_device_context: { limit: 20, windowSeconds: 300 },
  resolve_device_context: { limit: 20, windowSeconds: 300 },
  // Agent log tools
  set_agent_log_level: { limit: 5, windowSeconds: 600 },
  // Configuration policy tools
  apply_configuration_policy: { limit: 10, windowSeconds: 300 },
  remove_configuration_policy_assignment: { limit: 10, windowSeconds: 300 },
};

export interface GuardrailCheck {
  tier: AiToolTier;
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
  description?: string;
}

/**
 * Check guardrails for a tool invocation.
 * Returns the effective tier and whether approval is needed.
 */
export function checkGuardrails(
  toolName: string,
  input: Record<string, unknown>
): GuardrailCheck {
  // Tier 4: Blocked
  if (BLOCKED_TOOLS.has(toolName)) {
    return {
      tier: 4,
      allowed: false,
      requiresApproval: false,
      reason: `Tool "${toolName}" is not available`
    };
  }

  const baseTier = getToolTier(toolName);
  if (baseTier === undefined) {
    return {
      tier: 4,
      allowed: false,
      requiresApproval: false,
      reason: `Unknown tool: ${toolName}`
    };
  }

  // Check for action-based tier escalation
  const action = input.action as string | undefined;

  if (action && TIER3_ACTIONS[toolName]?.includes(action)) {
    return {
      tier: 3,
      allowed: true,
      requiresApproval: true,
      description: buildApprovalDescription(toolName, action, input)
    };
  }

  if (action && TIER2_ACTIONS[toolName]?.includes(action)) {
    return {
      tier: 2,
      allowed: true,
      requiresApproval: false
    };
  }

  // Use base tier from tool registration
  if (baseTier >= 3) {
    return {
      tier: baseTier,
      allowed: true,
      requiresApproval: true,
      description: buildApprovalDescription(toolName, action, input)
    };
  }

  return {
    tier: baseTier,
    allowed: true,
    requiresApproval: false
  };
}

/**
 * Check RBAC permissions for a tool invocation.
 * Returns null if allowed, or an error message if denied.
 */
export async function checkToolPermission(
  toolName: string,
  input: Record<string, unknown>,
  auth: AuthContext
): Promise<string | null> {
  const permDef = TOOL_PERMISSIONS[toolName];
  if (!permDef) return null; // No permission mapping — allow

  // Resolve the required permission (may be action-dependent)
  let required: { resource: string; action: string };
  const action = input.action as string | undefined;

  if ('resource' in permDef && 'action' in permDef) {
    required = permDef as { resource: string; action: string };
  } else if (action && (permDef as Record<string, { resource: string; action: string }>)[action]) {
    required = (permDef as Record<string, { resource: string; action: string }>)[action]!;
  } else if (action) {
    // Unknown action for a mapped tool — deny (fail-closed)
    return `Unknown action "${action}" for tool "${toolName}"`;
  } else {
    return null; // No action provided — allow (base tool permission applies)
  }

  const userPerms = await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId || undefined,
    orgId: auth.orgId || undefined,
  });

  if (!userPerms) {
    return 'Insufficient permissions: no role assigned';
  }

  if (!hasPermission(userPerms, required.resource, required.action)) {
    return `Insufficient permissions: requires ${required.resource}.${required.action}`;
  }

  return null;
}

/**
 * Check per-tool rate limits.
 * Returns null if allowed, or an error message if rate limited.
 */
export async function checkToolRateLimit(
  toolName: string,
  userId: string
): Promise<string | null> {
  const config = TOOL_RATE_LIMITS[toolName];
  if (!config) return null; // No rate limit for this tool

  const redis = getRedis();
  const key = `ai:tool:${userId}:${toolName}`;

  const result = await rateLimiter(redis, key, config.limit, config.windowSeconds);
  if (!result.allowed) {
    return `Tool rate limit exceeded for ${toolName}. Try again at ${result.resetAt.toISOString()}`;
  }

  return null;
}

/**
 * Build a human-readable description of what the tool is about to do.
 */
function buildApprovalDescription(
  toolName: string,
  action: string | undefined,
  input: Record<string, unknown>
): string {
  const parts: string[] = [];

  switch (toolName) {
    case 'execute_command':
      parts.push(`Execute "${input.commandType}" command`);
      if (input.deviceId) parts.push(`on device ${(input.deviceId as string).slice(0, 8)}...`);
      break;

    case 'run_script':
      parts.push(`Run script ${(input.scriptId as string)?.slice(0, 8) ?? 'unknown'}...`);
      if (Array.isArray(input.deviceIds)) parts.push(`on ${input.deviceIds.length} device(s)`);
      break;

    case 'manage_services':
      parts.push(`${action?.toUpperCase()} service "${input.serviceName}"`);
      if (input.deviceId) parts.push(`on device ${(input.deviceId as string).slice(0, 8)}...`);
      break;

    case 'security_scan':
      parts.push(`Security: ${action}`);
      if (input.threatId) parts.push(`threat ${(input.threatId as string).slice(0, 8)}...`);
      break;

    case 'file_operations':
      parts.push(`File ${action}: ${input.path}`);
      break;

    case 'network_discovery':
      parts.push(`Network discovery scan`);
      if (input.subnet) parts.push(`on ${input.subnet}`);
      break;

    case 'take_screenshot':
      parts.push('Capture screenshot');
      if (input.deviceId) parts.push(`from device ${(input.deviceId as string).slice(0, 8)}...`);
      break;

    case 'computer_control':
      parts.push(`Send input action: ${input.action}`);
      if (input.x !== undefined && input.y !== undefined) parts.push(`at (${input.x}, ${input.y})`);
      if (input.text) parts.push(`text: "${(input.text as string).slice(0, 30)}${(input.text as string).length > 30 ? '...' : ''}"`);
      if (input.key) parts.push(`key: ${input.key}`);
      if (input.deviceId) parts.push(`on device ${(input.deviceId as string).slice(0, 8)}...`);
      break;

    // Fleet tools
    case 'manage_policies':
      if (action === 'create') parts.push(`Create compliance policy "${input.name}"${input.enforcement ? ` (${input.enforcement} mode)` : ''}`);
      else if (action === 'delete') parts.push(`Delete compliance policy ${(input.policyId as string)?.slice(0, 8)}...`);
      else if (action === 'remediate') parts.push(`Trigger remediation on non-compliant devices for policy ${(input.policyId as string)?.slice(0, 8)}...`);
      else parts.push(`Policy ${action}: ${(input.policyId as string)?.slice(0, 8) ?? input.name ?? ''}...`);
      break;

    case 'manage_deployments':
      if (action === 'create') parts.push(`Create deployment "${input.name}" (${input.targetType} target)`);
      else if (action === 'start') parts.push(`Start deployment ${(input.deploymentId as string)?.slice(0, 8)}...`);
      else if (action === 'cancel') parts.push(`Cancel deployment ${(input.deploymentId as string)?.slice(0, 8)}...`);
      else parts.push(`Deployment ${action}: ${(input.deploymentId as string)?.slice(0, 8) ?? ''}...`);
      break;

    case 'manage_patches':
      if (action === 'install') parts.push(`Install ${Array.isArray(input.patchIds) ? input.patchIds.length : 0} patch(es) on ${Array.isArray(input.deviceIds) ? input.deviceIds.length : 0} device(s)`);
      else if (action === 'scan') parts.push(`Trigger patch scan on ${Array.isArray(input.deviceIds) ? input.deviceIds.length : 0} device(s)`);
      else if (action === 'rollback') parts.push(`Rollback patch ${(input.patchId as string)?.slice(0, 8)}...`);
      else parts.push(`Patch ${action}: ${(input.patchId as string)?.slice(0, 8) ?? ''}...`);
      break;

    case 'manage_groups':
      if (action === 'create') parts.push(`Create ${input.type ?? 'static'} device group "${input.name}"`);
      else if (action === 'delete') parts.push(`Delete device group ${(input.groupId as string)?.slice(0, 8)}...`);
      else parts.push(`Group ${action}: ${(input.groupId as string)?.slice(0, 8) ?? input.name ?? ''}...`);
      break;

    case 'manage_maintenance_windows':
      if (action === 'delete') parts.push(`Delete maintenance window ${(input.windowId as string)?.slice(0, 8)}...`);
      else parts.push(`Maintenance window ${action}: ${(input.windowId as string)?.slice(0, 8) ?? input.name ?? ''}...`);
      break;

    case 'manage_automations':
      if (action === 'create') parts.push(`Create automation "${input.name}"`);
      else if (action === 'delete') parts.push(`Delete automation ${(input.automationId as string)?.slice(0, 8)}...`);
      else if (action === 'run') parts.push(`Manually trigger automation ${(input.automationId as string)?.slice(0, 8)}...`);
      else parts.push(`Automation ${action}: ${(input.automationId as string)?.slice(0, 8) ?? input.name ?? ''}...`);
      break;

    case 'manage_alert_rules':
      if (action === 'delete_rule') parts.push(`Delete alert rule ${(input.ruleId as string)?.slice(0, 8)}...`);
      else parts.push(`Alert rule ${action}: ${(input.ruleId as string)?.slice(0, 8) ?? input.name ?? ''}...`);
      break;

    case 'manage_startup_items':
      parts.push(`${action?.toUpperCase()} startup item "${input.itemName}"`);
      if (input.deviceId) parts.push(`on device ${(input.deviceId as string).slice(0, 8)}...`);
      if (input.reason) parts.push(`(${(input.reason as string).slice(0, 50)})`);
      break;

    case 'set_agent_log_level':
      parts.push(`Set log level to ${input.level}`);
      if (input.deviceId) parts.push(`on device ${(input.deviceId as string).slice(0, 8)}...`);
      if (input.durationMinutes) parts.push(`for ${input.durationMinutes} minutes`);
      break;

    case 'apply_configuration_policy':
      parts.push(`Assign config policy ${(input.configPolicyId as string)?.slice(0, 8)}...`);
      parts.push(`to ${input.level} ${(input.targetId as string)?.slice(0, 8)}...`);
      break;

    case 'remove_configuration_policy_assignment':
      parts.push(`Remove config policy assignment ${(input.assignmentId as string)?.slice(0, 8)}...`);
      break;

    default:
      parts.push(`${toolName}${action ? `: ${action}` : ''}`);
  }

  return parts.join(' ');
}
