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
// HELPER_TOOL_SCOPING entry below (the executeTool gate
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
  'get_device_hardware_health',
  'get_device_time_status',
  'query_device_workloads',
  'list_time_sync_issues',
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
// (Backup verification is not offered here: the only backup tools registered
// for execution are org-wide — get_backup_status / query_backups / trigger_backup
// — and the Helper gate denies org-wide tools.)
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

/**
 * Helper device-scoping (security finding A, Phase 0).
 * Maps each tool the Breeze Helper may run to the input field naming its
 * target device. A tool absent from this map is org-wide and is DENIED under
 * a Helper context. Every tool in the whitelists above must have an
 * entry here (pinned by helperToolFilter.test.ts); mutating tools (tier>=2)
 * are additionally PAM-governed at the preToolUse gate (Phase 1).
 */
export const HELPER_TOOL_SCOPING: Record<string, 'deviceId' | 'deviceIds'> = {
  // Read-only (Phase 0 `basic` set).
  get_device_details: 'deviceId',
  get_device_hardware_health: 'deviceId',
  get_device_time_status: 'deviceId',
  query_device_workloads: 'deviceId',
  list_time_sync_issues: 'deviceId',
  analyze_metrics: 'deviceId',
  analyze_disk_usage: 'deviceId',
  get_cis_device_report: 'deviceId',
  get_security_posture: 'deviceId',
  take_screenshot: 'deviceId',
  analyze_screen: 'deviceId',
  search_logs: 'deviceIds',
  // Device-pinned safe actions (`standard`, Phase 1 governed).
  get_active_users: 'deviceId',
  get_user_experience_metrics: 'deviceId',
  manage_alerts: 'deviceId',
  manage_services: 'deviceId',
  disk_cleanup: 'deviceId',
  file_operations: 'deviceId',
  // Device-pinned destructive tools (`extended`, Phase 1 governed).
  computer_control: 'deviceId',
  execute_command: 'deviceId',
  security_scan: 'deviceId',
  s1_isolate_device: 'deviceId',
  network_discovery: 'deviceId',
  apply_cis_remediation: 'deviceId',
};

/**
 * Force a Helper tool call onto the Helper's own device, or deny it.
 * Pure. executeTool applies the result; the chat pre-tool-use gate
 * (aiAgentSdk.ts createSessionPreToolUse) validates the same scoped input
 * before anyone is asked to approve the call (#9854).
 */
export function applyHelperDeviceScope(
  toolName: string,
  input: Record<string, unknown>,
  helperDeviceId: string
): { input: Record<string, unknown> } | { error: string } {
  const field = HELPER_TOOL_SCOPING[toolName];
  if (!field) {
    return { error: `Tool '${toolName}' is not available in the Helper context` };
  }
  const value = field === 'deviceIds' ? [helperDeviceId] : helperDeviceId;
  return { input: { ...input, [field]: value } };
}

