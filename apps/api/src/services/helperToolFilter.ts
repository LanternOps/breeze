/**
 * Helper Tool Filter
 *
 * Tiered tool whitelist for the Breeze Helper app.
 * Permission levels control which MCP tools the helper AI can use.
 * Tools are grouped by risk: basic (read-only), standard (read + safe actions),
 * extended (includes destructive operations with approval).
 */

export type HelperPermissionLevel = 'basic' | 'standard' | 'extended';

const TOOL_WHITELIST: Record<HelperPermissionLevel, readonly string[]> = {
  basic: [
    'take_screenshot',
    'analyze_screen',
    'query_devices',
    'get_device_details',
    'analyze_metrics',
    'get_active_users',
    'get_user_experience_metrics',
    'get_security_posture',
    'analyze_disk_usage',
    'query_audit_log',
  ],
  standard: [
    'take_screenshot',
    'analyze_screen',
    'query_devices',
    'get_device_details',
    'analyze_metrics',
    'get_active_users',
    'get_user_experience_metrics',
    'get_security_posture',
    'analyze_disk_usage',
    'query_audit_log',
    'manage_alerts',
    'manage_services',
    'disk_cleanup',
    'file_operations',
    'computer_control',
  ],
  extended: [
    'take_screenshot',
    'analyze_screen',
    'query_devices',
    'get_device_details',
    'analyze_metrics',
    'get_active_users',
    'get_user_experience_metrics',
    'get_security_posture',
    'analyze_disk_usage',
    'query_audit_log',
    'manage_alerts',
    'manage_services',
    'disk_cleanup',
    'file_operations',
    'computer_control',
    'execute_command',
    'security_scan',
    'network_discovery',
  ],
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
