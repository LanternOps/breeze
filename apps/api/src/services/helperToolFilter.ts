/**
 * Helper Tool Filter
 *
 * Tiered tool whitelist for the Breeze Helper app.
 * Permission levels control which MCP tools the helper AI can use.
 * Tools are grouped by risk: basic (read-only), standard (read + safe actions),
 * extended (includes destructive operations with approval).
 */

export type HelperPermissionLevel = 'basic' | 'standard' | 'extended';

// Every tool at every level MUST be single-device: it needs a
// HELPER_TOOL_SCOPING entry in services/aiTools.ts (the executeTool gate
// pins the declared device field to the Helper's own device and DENIES any
// unscoped tool — security finding A, Phase 0). Org-wide enumeration tools
// (query_devices, get_fleet_health, …) and tools keyed on non-device
// resources (s1_threat_action takes threatIds) therefore cannot appear here.
//
// Mutating tools (tier>=2) are governed by PAM (Phase 1): each invocation
// becomes an elevation_request(ai_tool_action) decided by pam_rules —
// default posture require_approval via POST /pam/elevation-requests/:id/respond.
const BASIC_TOOLS = [
  'get_device_details',
  'analyze_metrics',
  'analyze_disk_usage',
  'get_cis_device_report',
  'get_security_posture',
  'take_screenshot',
  'analyze_screen',
  'search_logs',
] as const;

// basic + device-pinned safe actions. The mutating ones are PAM-governed.
const STANDARD_TOOLS = [
  ...BASIC_TOOLS,
  'get_active_users',
  'get_user_experience_metrics',
  'manage_alerts',
  'manage_services',
  'disk_cleanup',
  'file_operations',
] as const;

// standard + device-pinned destructive tools — always PAM-governed.
// (run_backup_verification is deliberately absent: it is declared on the SDK
// MCP server but has no executeTool registration, so it cannot run anywhere.)
const EXTENDED_TOOLS = [
  ...STANDARD_TOOLS,
  'computer_control',
  'execute_command',
  'security_scan',
  's1_isolate_device',
  'network_discovery',
  'apply_cis_remediation',
] as const;

const TOOL_WHITELIST: Record<HelperPermissionLevel, readonly string[]> = {
  basic: BASIC_TOOLS,
  standard: STANDARD_TOOLS,
  extended: EXTENDED_TOOLS,
};

const MCP_PREFIX = 'mcp__breeze__';

/**
 * Get the list of allowed bare tool names for a permission level.
 */
export function getHelperAllowedTools(level: HelperPermissionLevel): string[] {
  return [...TOOL_WHITELIST[level]];
}

/**
 * Get MCP-prefixed tool names for use with the SDK's allowedTools option.
 */
export function getHelperAllowedMcpToolNames(level: HelperPermissionLevel): string[] {
  return TOOL_WHITELIST[level].map(name => `${MCP_PREFIX}${name}`);
}

/**
 * Validate that a tool name is allowed for the given permission level.
 * Returns null if allowed, error message if blocked.
 */
export function validateHelperToolAccess(
  toolName: string,
  level: HelperPermissionLevel,
): string | null {
  const bareName = toolName.startsWith(MCP_PREFIX)
    ? toolName.slice(MCP_PREFIX.length)
    : toolName;

  const allowed = TOOL_WHITELIST[level];
  if (!allowed.includes(bareName)) {
    return `Tool '${bareName}' is not available at the '${level}' permission level`;
  }

  return null;
}
