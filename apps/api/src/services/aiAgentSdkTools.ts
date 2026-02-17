/**
 * AI Agent SDK Tool Definitions
 *
 * Defines all 17 Breeze tools for use with the Claude Agent SDK's MCP server.
 * Each tool delegates to executeTool() from aiTools.ts, which validates input
 * via Zod schemas and calls the existing handler with org-scoped auth context.
 */

import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { AuthContext } from '../middleware/auth';
import { executeTool } from './aiTools';
import type { AiToolTier } from '@breeze/shared/types/ai';
import { compactToolResultForChat } from './aiToolOutput';

/**
 * Callback invoked before tool execution to enforce guardrails, RBAC,
 * rate limits, and approval gates. Blocks execution until resolved.
 */
export type PreToolUseCallback = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<{ allowed: true } | { allowed: false; error: string }>;

/**
 * Callback invoked after each tool execution (success or failure).
 * Used by aiAgentSdk.ts to persist tool_result messages, execution records,
 * audit logs, and SSE events.
 */
export type PostToolUseCallback = (
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean,
  durationMs: number,
) => Promise<void>;

// ============================================
// Tool Tier Map (used by guardrails checks)
// ============================================

export const TOOL_TIERS = {
  query_devices: 1,
  get_device_details: 1,
  analyze_metrics: 1,
  get_active_users: 1,
  get_user_experience_metrics: 1,
  manage_alerts: 1, // Base tier; action-level escalation handled in guardrails
  execute_command: 3,
  run_script: 3,
  manage_services: 3,
  security_scan: 3,
  get_security_posture: 1,
  file_operations: 1, // Base tier; write/delete/mkdir/rename escalated to 3 in guardrails
  analyze_disk_usage: 1,
  disk_cleanup: 1, // Base tier; execute escalated to 3 in guardrails
  query_audit_log: 1,
  network_discovery: 3,
  take_screenshot: 2,
  analyze_screen: 1,
  computer_control: 3,
  // Fleet orchestration tools
  manage_policies: 1,        // Action-level escalation in guardrails
  manage_deployments: 1,     // Action-level escalation in guardrails
  manage_patches: 1,         // Action-level escalation in guardrails
  manage_groups: 1,          // Action-level escalation in guardrails
  manage_maintenance_windows: 1, // Action-level escalation in guardrails
  manage_automations: 1,     // Action-level escalation in guardrails
  manage_alert_rules: 1,     // Action-level escalation in guardrails
  generate_report: 1,        // Action-level escalation in guardrails
  // Brain device context tools
  get_device_context: 1,
  set_device_context: 2,
  resolve_device_context: 2,
} as const satisfies Readonly<Record<string, AiToolTier>> as Readonly<Record<string, AiToolTier>>;

// All tool names, prefixed for SDK MCP format
export const BREEZE_MCP_TOOL_NAMES = Object.keys(TOOL_TIERS).map(
  name => `mcp__breeze__${name}`
);

// ============================================
// Helper: Create tool handler that delegates to executeTool
// ============================================

const TOOL_EXECUTION_TIMEOUT_MS = 60_000; // 60s safety timeout

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tool execution timed out after ${ms}ms: ${label}`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function makeHandler(
  toolName: string,
  getAuth: () => AuthContext,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
) {
  return async (args: Record<string, unknown>) => {
    const startTime = Date.now();

    // Pre-execution check (guardrails, RBAC, rate limits, approval)
    if (onPreToolUse) {
      let check: { allowed: true } | { allowed: false; error: string };
      try {
        check = await onPreToolUse(toolName, args);
      } catch (err) {
        console.error(`[AI-SDK] PreToolUse threw for ${toolName}:`, err);
        check = { allowed: false, error: 'Internal guardrails error. Tool execution blocked.' };
      }
      if (!check.allowed) {
        if (onPostToolUse) {
          try { await onPostToolUse(toolName, args, JSON.stringify({ error: check.error }), true, 0); }
          catch (err) { console.error('[AI-SDK] PostToolUse callback failed:', err); }
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: check.error }) }],
          isError: true,
        };
      }
    }
    try {
      const auth = getAuth();
      const result = await withTimeout(
        executeTool(toolName, args, auth),
        TOOL_EXECUTION_TIMEOUT_MS,
        toolName,
      );
      const compactResult = compactToolResultForChat(toolName, result);

      // For screenshot/vision tools, return image content blocks for Claude Vision
      if ((toolName === 'take_screenshot' || toolName === 'analyze_screen' || toolName === 'computer_control') && !compactResult.includes('"error"')) {
        try {
          const parsed = JSON.parse(result);
          const imageBase64 = parsed.imageBase64;
          if (imageBase64) {
            const durationMs = Date.now() - startTime;
            if (onPostToolUse) {
              try { await onPostToolUse(toolName, args, JSON.stringify({ actionExecuted: parsed.actionExecuted, width: parsed.width, height: parsed.height, format: parsed.format, sizeBytes: parsed.sizeBytes, capturedAt: parsed.capturedAt }), false, durationMs); }
              catch (err) { console.error('[AI-SDK] PostToolUse callback failed:', err); }
            }
            const contentBlocks: Array<{ type: string; source?: { type: string; media_type: string; data: string }; text?: string }> = [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: imageBase64,
                },
              },
            ];
            if (toolName === 'analyze_screen' && parsed.device) {
              contentBlocks.push({
                type: 'text',
                text: JSON.stringify({
                  analysisContext: parsed.analysisContext,
                  device: parsed.device,
                  capturedAt: parsed.capturedAt,
                  resolution: `${parsed.width}x${parsed.height}`,
                }),
              });
            }
            if (toolName === 'computer_control') {
              contentBlocks.push({
                type: 'text',
                text: JSON.stringify({
                  actionExecuted: parsed.actionExecuted,
                  capturedAt: parsed.capturedAt,
                  resolution: `${parsed.width}x${parsed.height}`,
                }),
              });
            }
            return { content: contentBlocks };
          }
        } catch {
          // Fall through to normal text response
        }
      }

      const durationMs = Date.now() - startTime;
      if (onPostToolUse) {
        try { await onPostToolUse(toolName, args, compactResult, false, durationMs); }
        catch (err) { console.error('[AI-SDK] PostToolUse callback failed:', err); }
      }
      return { content: [{ type: 'text' as const, text: compactResult }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Tool execution failed';
      const durationMs = Date.now() - startTime;
      console.error(`[AI-SDK] Tool ${toolName} failed in ${durationMs}ms:`, message);
      if (onPostToolUse) {
        try { await onPostToolUse(toolName, args, JSON.stringify({ error: message }), true, durationMs); }
        catch (cbErr) { console.error('[AI-SDK] PostToolUse callback failed:', cbErr); }
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  };
}

// ============================================
// SDK MCP Server Factory
// ============================================

/**
 * Creates an SDK MCP server instance with all Breeze tools.
 * Auth context is fetched lazily via the getAuth thunk so all tool handlers
 * see the latest org-scoped access even when the session is reused.
 * Optional postToolUse callback fires after every tool execution for persistence/audit.
 */
export function createBreezeMcpServer(
  getAuth: () => AuthContext,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
) {
  const uuid = z.string().uuid();

  const tools = [
    tool(
      'query_devices',
      'Search and filter devices in the organization. Returns a summary list.',
      {
        status: z.enum(['online', 'offline', 'maintenance', 'decommissioned']).optional(),
        osType: z.enum(['windows', 'macos', 'linux']).optional(),
        siteId: z.string().uuid().optional(),
        search: z.string().max(200).optional(),
        tags: z.array(z.string().max(100)).max(20).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('query_devices', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_device_details',
      'Get comprehensive details about a specific device including hardware, network, disk, and metrics.',
      { deviceId: uuid },
      makeHandler('get_device_details', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'analyze_metrics',
      'Query and analyze time-series metrics (CPU, RAM, disk, network) for a device.',
      {
        deviceId: uuid,
        metric: z.enum(['cpu', 'ram', 'disk', 'network', 'all']).optional(),
        hoursBack: z.number().int().min(1).max(168).optional(),
        aggregation: z.enum(['raw', 'hourly', 'daily']).optional(),
      },
      makeHandler('analyze_metrics', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_active_users',
      'Query active user sessions for one device or across the fleet.',
      {
        deviceId: uuid.optional(),
        limit: z.number().int().min(1).max(200).optional(),
        idleThresholdMinutes: z.number().int().min(1).max(1440).optional(),
      },
      makeHandler('get_active_users', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_user_experience_metrics',
      'Summarize login performance and session behavior trends.',
      {
        deviceId: uuid.optional(),
        username: z.string().max(255).optional(),
        daysBack: z.number().int().min(1).max(365).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      makeHandler('get_user_experience_metrics', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_alerts',
      'Query, view, acknowledge, or resolve alerts.',
      {
        action: z.enum(['list', 'get', 'acknowledge', 'resolve']),
        alertId: uuid.optional(),
        status: z.enum(['active', 'acknowledged', 'resolved', 'suppressed']).optional(),
        severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
        deviceId: uuid.optional(),
        limit: z.number().int().min(1).max(100).optional(),
        resolutionNote: z.string().max(1000).optional(),
      },
      makeHandler('manage_alerts', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'execute_command',
      'Execute a system command on a device. Requires user approval.',
      {
        deviceId: uuid,
        commandType: z.enum([
          'list_processes', 'kill_process',
          'list_services', 'start_service', 'stop_service', 'restart_service',
          'file_list', 'file_read',
          'event_logs_list', 'event_logs_query',
        ]),
        payload: z.record(z.unknown()).optional(),
      },
      makeHandler('execute_command', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'run_script',
      'Execute a script on one or more devices.',
      {
        scriptId: uuid,
        deviceIds: z.array(uuid).min(1).max(10),
        parameters: z.record(z.unknown()).optional(),
      },
      makeHandler('run_script', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_services',
      'List, start, stop, or restart system services on a device.',
      {
        deviceId: uuid,
        action: z.enum(['list', 'start', 'stop', 'restart']),
        serviceName: z.string().max(255).optional(),
      },
      makeHandler('manage_services', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'security_scan',
      'Run security scans on a device, or manage detected threats.',
      {
        deviceId: uuid,
        action: z.enum(['scan', 'status', 'quarantine', 'remove', 'restore']),
        threatId: z.string().max(255).optional(),
      },
      makeHandler('security_scan', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_security_posture',
      'Get fleet-wide or device-level security posture scores with recommendations.',
      {
        deviceId: uuid.optional(),
        orgId: uuid.optional(),
        minScore: z.number().int().min(0).max(100).optional(),
        maxScore: z.number().int().min(0).max(100).optional(),
        riskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional(),
        includeRecommendations: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      makeHandler('get_security_posture', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'file_operations',
      'Perform file operations on a device. Read/list are safe; write/delete require approval.',
      {
        deviceId: uuid,
        action: z.enum(['list', 'read', 'write', 'delete', 'mkdir', 'rename']),
        path: z.string().max(4096),
        content: z.string().max(1_000_000).optional(),
        newPath: z.string().max(4096).optional(),
      },
      makeHandler('file_operations', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'analyze_disk_usage',
      'Analyze filesystem usage for a device. Can run a fresh scan.',
      {
        deviceId: uuid,
        refresh: z.boolean().optional(),
        path: z.string().max(4096).optional(),
        maxDepth: z.number().int().min(1).max(64).optional(),
        topFiles: z.number().int().min(1).max(500).optional(),
        topDirs: z.number().int().min(1).max(200).optional(),
        maxEntries: z.number().int().min(1_000).max(25_000_000).optional(),
        workers: z.number().int().min(1).max(32).optional(),
        timeoutSeconds: z.number().int().min(5).max(900).optional(),
        maxCandidates: z.number().int().min(1).max(200).optional(),
      },
      makeHandler('analyze_disk_usage', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'disk_cleanup',
      'Preview or execute disk cleanup. Preview is read-only. Execute deletes approved candidates.',
      {
        deviceId: uuid,
        action: z.enum(['preview', 'execute']),
        categories: z.array(z.string()).max(10).optional(),
        paths: z.array(z.string().max(4096)).min(1).max(200).optional(),
        maxCandidates: z.number().int().min(1).max(200).optional(),
      },
      makeHandler('disk_cleanup', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'query_audit_log',
      'Search the audit log for recent actions.',
      {
        action: z.string().max(100).optional(),
        resourceType: z.string().max(100).optional(),
        resourceId: uuid.optional(),
        actorType: z.enum(['user', 'api_key', 'agent', 'system']).optional(),
        hoursBack: z.number().int().min(1).max(168).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('query_audit_log', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'network_discovery',
      'Initiate a network discovery scan from a device.',
      {
        deviceId: uuid,
        subnet: z.string().max(50).optional(),
        scanType: z.enum(['ping', 'arp', 'full']).optional(),
      },
      makeHandler('network_discovery', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'take_screenshot',
      'Capture a screenshot of the device screen for visual analysis.',
      {
        deviceId: uuid,
        monitor: z.number().int().min(0).max(10).optional(),
      },
      makeHandler('take_screenshot', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'analyze_screen',
      'Take a screenshot and analyze what is visible on the device screen.',
      {
        deviceId: uuid,
        context: z.string().max(500).optional(),
        monitor: z.number().int().min(0).max(10).optional(),
      },
      makeHandler('analyze_screen', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'computer_control',
      'Control a device by sending mouse/keyboard input and capturing screenshots. Returns a screenshot after each action. Actions: screenshot, left_click, right_click, middle_click, double_click, mouse_move, scroll, key, type.',
      {
        deviceId: uuid,
        action: z.enum(['screenshot', 'left_click', 'right_click', 'middle_click', 'double_click', 'mouse_move', 'scroll', 'key', 'type']),
        x: z.number().int().min(0).max(10000).optional(),
        y: z.number().int().min(0).max(10000).optional(),
        text: z.string().max(1000).optional(),
        key: z.string().max(50).optional(),
        modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).max(4).optional(),
        scrollDelta: z.number().int().min(-100).max(100).optional(),
        monitor: z.number().int().min(0).max(10).optional(),
        captureAfter: z.boolean().optional(),
        captureDelayMs: z.number().int().min(0).max(3000).optional(),
      },
      makeHandler('computer_control', getAuth, onPreToolUse, onPostToolUse)
    ),

    // Fleet orchestration tools

    tool(
      'manage_policies',
      'Manage compliance policies: list, get, check compliance, evaluate, create, update, activate/deactivate, delete, remediate.',
      {
        action: z.enum(['list', 'get', 'compliance_status', 'compliance_summary', 'evaluate', 'create', 'update', 'activate', 'deactivate', 'delete', 'remediate']),
        policyId: uuid.optional(),
        enforcement: z.enum(['monitor', 'warn', 'enforce']).optional(),
        enabled: z.boolean().optional(),
        name: z.string().max(255).optional(),
        description: z.string().max(2000).optional(),
        rules: z.record(z.unknown()).optional(),
        targets: z.record(z.unknown()).optional(),
        checkIntervalMinutes: z.number().int().min(1).max(1440).optional(),
        remediationScriptId: uuid.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('manage_policies', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_deployments',
      'Manage staged deployments: list, get details, device status, create, start, pause, resume, cancel.',
      {
        action: z.enum(['list', 'get', 'device_status', 'create', 'start', 'pause', 'resume', 'cancel']),
        deploymentId: uuid.optional(),
        status: z.enum(['draft', 'pending', 'running', 'paused', 'completed', 'failed', 'cancelled']).optional(),
        name: z.string().max(200).optional(),
        type: z.string().max(50).optional(),
        payload: z.record(z.unknown()).optional(),
        targetType: z.string().max(20).optional(),
        targetConfig: z.record(z.unknown()).optional(),
        rolloutConfig: z.record(z.unknown()).optional(),
        schedule: z.record(z.unknown()).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('manage_deployments', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_patches',
      'Manage patches: list, compliance, scan, approve, decline, defer, bulk approve, install, rollback.',
      {
        action: z.enum(['list', 'compliance', 'scan', 'approve', 'decline', 'defer', 'bulk_approve', 'install', 'rollback']),
        patchId: uuid.optional(),
        patchIds: z.array(uuid).max(50).optional(),
        deviceIds: z.array(uuid).max(50).optional(),
        source: z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom']).optional(),
        severity: z.enum(['critical', 'important', 'moderate', 'low', 'unknown']).optional(),
        status: z.enum(['pending', 'approved', 'rejected', 'deferred']).optional(),
        deferUntil: z.string().optional(),
        notes: z.string().max(1000).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('manage_patches', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_groups',
      'Manage device groups: list, get with members, preview filters, membership log, create, update, delete, add/remove devices.',
      {
        action: z.enum(['list', 'get', 'preview', 'membership_log', 'create', 'update', 'delete', 'add_devices', 'remove_devices']),
        groupId: uuid.optional(),
        name: z.string().max(255).optional(),
        type: z.enum(['static', 'dynamic']).optional(),
        siteId: uuid.optional(),
        filterConditions: z.record(z.unknown()).optional(),
        deviceIds: z.array(uuid).max(100).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      makeHandler('manage_groups', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_maintenance_windows',
      'Manage maintenance windows: list, get with occurrences, check active now, create, update, delete.',
      {
        action: z.enum(['list', 'get', 'active_now', 'create', 'update', 'delete']),
        windowId: uuid.optional(),
        name: z.string().max(255).optional(),
        description: z.string().max(2000).optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        timezone: z.string().max(50).optional(),
        recurrence: z.enum(['once', 'daily', 'weekly', 'monthly', 'custom']).optional(),
        recurrenceRule: z.record(z.unknown()).optional(),
        targetType: z.string().max(50).optional(),
        siteIds: z.array(uuid).optional(),
        groupIds: z.array(uuid).optional(),
        deviceIds: z.array(uuid).optional(),
        suppressAlerts: z.boolean().optional(),
        suppressPatching: z.boolean().optional(),
        suppressAutomations: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('manage_maintenance_windows', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_automations',
      'Manage automations: list, get, run history, create, update, delete, enable/disable, manually run.',
      {
        action: z.enum(['list', 'get', 'history', 'create', 'update', 'delete', 'enable', 'disable', 'run']),
        automationId: uuid.optional(),
        name: z.string().max(200).optional(),
        description: z.string().max(2000).optional(),
        trigger: z.record(z.unknown()).optional(),
        conditions: z.record(z.unknown()).optional(),
        actions: z.array(z.record(z.unknown())).min(1).max(20).optional(),
        onFailure: z.enum(['stop', 'continue', 'notify']).optional(),
        enabled: z.boolean().optional(),
        triggerType: z.enum(['schedule', 'event', 'webhook', 'manual']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('manage_automations', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_alert_rules',
      'Manage alert rules: list/get/create/update/delete rules, test rules, list channels, alert summary.',
      {
        action: z.enum(['list_rules', 'get_rule', 'create_rule', 'update_rule', 'delete_rule', 'test_rule', 'list_channels', 'alert_summary']),
        ruleId: uuid.optional(),
        name: z.string().max(200).optional(),
        templateId: uuid.optional(),
        targetType: z.string().max(50).optional(),
        targetId: uuid.optional(),
        overrideSettings: z.record(z.unknown()).optional(),
        isActive: z.boolean().optional(),
        severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('manage_alert_rules', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'generate_report',
      'Manage reports: list, generate on-demand, get data, create/update/delete definitions, view history.',
      {
        action: z.enum(['list', 'generate', 'data', 'create', 'update', 'delete', 'history']),
        reportId: uuid.optional(),
        reportType: z.enum(['device_inventory', 'software_inventory', 'alert_summary', 'compliance', 'performance', 'executive_summary']).optional(),
        name: z.string().max(255).optional(),
        config: z.record(z.unknown()).optional(),
        schedule: z.enum(['one_time', 'daily', 'weekly', 'monthly']).optional(),
        format: z.enum(['csv', 'pdf', 'excel']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      makeHandler('generate_report', getAuth, onPreToolUse, onPostToolUse)
    ),

    // Brain device context tools

    tool(
      'get_device_context',
      'Retrieve past AI memory/context about a device. Returns known issues, quirks, follow-ups, and preferences from previous interactions.',
      {
        deviceId: uuid,
        includeResolved: z.boolean().optional().default(false),
      },
      makeHandler('get_device_context', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'set_device_context',
      'Record new context/memory about a device for future reference. Use to remember issues, quirks, follow-ups, or preferences.',
      {
        deviceId: uuid,
        contextType: z.enum(['issue', 'quirk', 'followup', 'preference']),
        summary: z.string().min(1).max(255),
        details: z.record(z.unknown()).optional(),
        expiresInDays: z.number().int().positive().max(365).optional(),
      },
      makeHandler('set_device_context', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'resolve_device_context',
      'Mark a context entry as resolved/completed. Resolved items are hidden from active context but preserved in history.',
      {
        contextId: uuid,
      },
      makeHandler('resolve_device_context', getAuth, onPreToolUse, onPostToolUse)
    ),
  ];

  return createSdkMcpServer({
    name: 'breeze',
    version: '1.0.0',
    tools,
  });
}
