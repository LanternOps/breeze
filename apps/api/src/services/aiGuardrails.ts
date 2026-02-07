/**
 * AI Guardrails Service
 *
 * Tiered permission system for AI tool execution:
 * - Tier 1: Auto-execute (read-only tools)
 * - Tier 2: Auto-execute + audit (low-risk mutations)
 * - Tier 3: Requires user approval (destructive/mutating operations)
 * - Tier 4: Blocked (auth/user/role modifications, cross-org access)
 */

import { getToolTier } from './aiTools';

type AiToolTier = 1 | 2 | 3 | 4;

// Tools that are always blocked (Tier 4)
const BLOCKED_TOOLS = new Set<string>([
  // No tools are explicitly blocked at the tool level —
  // cross-org access is enforced by orgCondition in each handler
]);

// Mutations that are Tier 2 (auto-execute + audit) despite being in a Tier 1 tool
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
