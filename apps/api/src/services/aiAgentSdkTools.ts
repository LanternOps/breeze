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

/**
 * Callback invoked after each tool execution (success or failure).
 * Used by aiAgentSdk.ts to persist tool_result messages, execution records,
 * audit logs, and SSE events — matching the old agenticLoop behavior.
 */
export type PostToolUseCallback = (
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean,
  durationMs: number,
) => Promise<void>;

// ============================================
// Tool Tier Map (for canUseTool callback)
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
  create_automation: 3,
  network_discovery: 3,
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

function makeHandler(toolName: string, getAuth: () => AuthContext, onPostToolUse?: PostToolUseCallback) {
  return async (args: Record<string, unknown>) => {
    const startTime = Date.now();
    try {
      const auth = getAuth();
      const result = await withTimeout(
        executeTool(toolName, args, auth),
        TOOL_EXECUTION_TIMEOUT_MS,
        toolName,
      );
      const durationMs = Date.now() - startTime;
      if (onPostToolUse) {
        try { await onPostToolUse(toolName, args, result, false, durationMs); }
        catch (err) { console.error('[AI-SDK] PostToolUse callback failed:', err); }
      }
      return { content: [{ type: 'text' as const, text: result }] };
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
export function createBreezeMcpServer(getAuth: () => AuthContext, onPostToolUse?: PostToolUseCallback) {
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
      makeHandler('query_devices', getAuth, onPostToolUse)
    ),

    tool(
      'get_device_details',
      'Get comprehensive details about a specific device including hardware, network, disk, and metrics.',
      { deviceId: uuid },
      makeHandler('get_device_details', getAuth, onPostToolUse)
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
      makeHandler('analyze_metrics', getAuth, onPostToolUse)
    ),

    tool(
      'get_active_users',
      'Query active user sessions for one device or across the fleet.',
      {
        deviceId: uuid.optional(),
        limit: z.number().int().min(1).max(200).optional(),
        idleThresholdMinutes: z.number().int().min(1).max(1440).optional(),
      },
      makeHandler('get_active_users', getAuth, onPostToolUse)
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
      makeHandler('get_user_experience_metrics', getAuth, onPostToolUse)
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
      makeHandler('manage_alerts', getAuth, onPostToolUse)
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
      makeHandler('execute_command', getAuth, onPostToolUse)
    ),

    tool(
      'run_script',
      'Execute a script on one or more devices.',
      {
        scriptId: uuid,
        deviceIds: z.array(uuid).min(1).max(10),
        parameters: z.record(z.unknown()).optional(),
      },
      makeHandler('run_script', getAuth, onPostToolUse)
    ),

    tool(
      'manage_services',
      'List, start, stop, or restart system services on a device.',
      {
        deviceId: uuid,
        action: z.enum(['list', 'start', 'stop', 'restart']),
        serviceName: z.string().max(255).optional(),
      },
      makeHandler('manage_services', getAuth, onPostToolUse)
    ),

    tool(
      'security_scan',
      'Run security scans on a device, or manage detected threats.',
      {
        deviceId: uuid,
        action: z.enum(['scan', 'status', 'quarantine', 'remove', 'restore']),
        threatId: z.string().max(255).optional(),
      },
      makeHandler('security_scan', getAuth, onPostToolUse)
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
      makeHandler('get_security_posture', getAuth, onPostToolUse)
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
      makeHandler('file_operations', getAuth, onPostToolUse)
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
      },
      makeHandler('analyze_disk_usage', getAuth, onPostToolUse)
    ),

    tool(
      'disk_cleanup',
      'Preview or execute disk cleanup. Preview is read-only. Execute deletes approved candidates.',
      {
        deviceId: uuid,
        action: z.enum(['preview', 'execute']),
        categories: z.array(z.string()).max(10).optional(),
        paths: z.array(z.string().max(4096)).min(1).max(200).optional(),
      },
      makeHandler('disk_cleanup', getAuth, onPostToolUse)
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
      makeHandler('query_audit_log', getAuth, onPostToolUse)
    ),

    tool(
      'create_automation',
      'Create a new automation rule. Requires user approval.',
      {
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        trigger: z.record(z.unknown()),
        conditions: z.record(z.unknown()).optional(),
        actions: z.array(z.record(z.unknown())).min(1).max(20),
        enabled: z.boolean().optional(),
      },
      makeHandler('create_automation', getAuth, onPostToolUse)
    ),

    tool(
      'network_discovery',
      'Initiate a network discovery scan from a device.',
      {
        deviceId: uuid,
        subnet: z.string().max(50).optional(),
        scanType: z.enum(['ping', 'arp', 'full']).optional(),
      },
      makeHandler('network_discovery', getAuth, onPostToolUse)
    ),
  ];

  return createSdkMcpServer({
    name: 'breeze',
    version: '1.0.0',
    tools,
  });
}
