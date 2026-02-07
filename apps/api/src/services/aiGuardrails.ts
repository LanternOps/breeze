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
  manage_services: ['list']
};

// Mutations that require approval (Tier 3) even if the tool is registered as Tier 1
const TIER3_ACTIONS: Record<string, string[]> = {
  file_operations: ['write', 'delete', 'mkdir', 'rename'],
  manage_services: ['start', 'stop', 'restart'],
  security_scan: ['quarantine', 'remove', 'restore']
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
  file_operations: {
    list: { resource: 'devices', action: 'read' },
    read: { resource: 'devices', action: 'read' },
    write: { resource: 'devices', action: 'execute' },
    delete: { resource: 'devices', action: 'execute' },
    mkdir: { resource: 'devices', action: 'execute' },
    rename: { resource: 'devices', action: 'execute' },
  },
  query_audit_log: { resource: 'audit', action: 'read' },
  create_automation: { resource: 'automations', action: 'write' },
  network_discovery: { resource: 'devices', action: 'execute' },
};

// Per-tool rate limits: { limit, windowSeconds }
const TOOL_RATE_LIMITS: Record<string, { limit: number; windowSeconds: number }> = {
  execute_command: { limit: 10, windowSeconds: 300 },
  run_script: { limit: 5, windowSeconds: 300 },
  security_scan: { limit: 3, windowSeconds: 600 },
  network_discovery: { limit: 2, windowSeconds: 600 },
  create_automation: { limit: 5, windowSeconds: 600 },
  file_operations: { limit: 20, windowSeconds: 300 },
  manage_services: { limit: 10, windowSeconds: 300 },
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
  } else {
    return null; // Unknown action variant — allow
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

    case 'create_automation':
      parts.push(`Create automation "${input.name}"`);
      break;

    case 'network_discovery':
      parts.push(`Network discovery scan`);
      if (input.subnet) parts.push(`on ${input.subnet}`);
      break;

    default:
      parts.push(`${toolName}${action ? `: ${action}` : ''}`);
  }

  return parts.join(' ');
}
