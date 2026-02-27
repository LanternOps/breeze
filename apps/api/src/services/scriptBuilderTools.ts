/**
 * Script Builder AI Tool Definitions
 *
 * Curated subset of Breeze AI tools for the script editor assistant.
 * Includes 2 custom apply tools (code + metadata) and 8 existing tools.
 */

import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { AuthContext } from '../middleware/auth';
import { executeTool } from './aiTools';
import { withSystemDbAccessContext } from '../db';
import type { AiToolTier } from '@breeze/shared/types/ai';
import { compactToolResultForChat } from './aiToolOutput';
import { captureException } from './sentry';
import type { PreToolUseCallback, PostToolUseCallback } from './aiAgentSdkTools';

const TOOL_EXECUTION_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tool execution timed out after ${ms}ms: ${label}`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ============================================
// Tool Tier Map
// ============================================

export const SCRIPT_BUILDER_TOOL_TIERS: Record<string, AiToolTier> = {
  apply_script_code: 1,
  apply_script_metadata: 1,
  query_devices: 1,
  get_device_details: 1,
  manage_alerts: 1,
  list_scripts: 1,
  get_script_details: 1,
  list_script_templates: 1,
  get_script_execution_history: 1,
  execute_script_on_device: 3,
};

export const SCRIPT_BUILDER_MCP_TOOL_NAMES = Object.keys(SCRIPT_BUILDER_TOOL_TIERS).map(
  name => `mcp__script_builder__${name}`
);

// ============================================
// Handler factory for existing tools
// ============================================

function makeExistingHandler(
  toolName: string,
  getAuth: () => AuthContext,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
) {
  return async (args: Record<string, unknown>) => {
    const startTime = Date.now();

    if (onPreToolUse) {
      let check: { allowed: true } | { allowed: false; error: string };
      try {
        check = await onPreToolUse(toolName, args);
      } catch (err) {
        captureException(err);
        console.error(`[ScriptBuilder] PreToolUse threw for ${toolName}:`, err);
        check = { allowed: false, error: 'Internal guardrails error.' };
      }
      if (!check.allowed) {
        if (onPostToolUse) {
          try { await onPostToolUse(toolName, args, JSON.stringify({ error: check.error }), true, 0); }
          catch (err) { captureException(err); console.error('[ScriptBuilder] PostToolUse failed:', err); }
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: check.error }) }], isError: true };
      }
    }

    try {
      const auth = getAuth();
      const result = await withTimeout(
        withSystemDbAccessContext(() => executeTool(toolName, args, auth)),
        TOOL_EXECUTION_TIMEOUT_MS,
        toolName,
      );
      const compactResult = compactToolResultForChat(toolName, result);
      const durationMs = Date.now() - startTime;

      if (onPostToolUse) {
        try { await onPostToolUse(toolName, args, compactResult, false, durationMs); }
        catch (err) { captureException(err); console.error('[ScriptBuilder] PostToolUse failed:', err); }
      }

      return { content: [{ type: 'text' as const, text: compactResult }] };
    } catch (err) {
      captureException(err);
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      const durationMs = Date.now() - startTime;

      if (onPostToolUse) {
        try { await onPostToolUse(toolName, args, JSON.stringify({ error: errorMsg }), true, durationMs); }
        catch (e) { captureException(e); console.error('[ScriptBuilder] PostToolUse failed:', e); }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: errorMsg }) }], isError: true };
    }
  };
}

// ============================================
// Apply tool handlers (emit SSE events, no DB execution)
// ============================================

function makeApplyHandler(
  toolName: string,
  onPostToolUse?: PostToolUseCallback,
) {
  return async (args: Record<string, unknown>) => {
    const startTime = Date.now();
    const output = JSON.stringify({ applied: true, toolName, ...args });
    const durationMs = Date.now() - startTime;

    if (onPostToolUse) {
      try { await onPostToolUse(toolName, args, output, false, durationMs); }
      catch (err) { captureException(err); console.error('[ScriptBuilder] PostToolUse failed:', err); }
    }

    return { content: [{ type: 'text' as const, text: output }] };
  };
}

// ============================================
// MCP Server Factory
// ============================================

export function createScriptBuilderMcpServer(
  getAuth: () => AuthContext,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
) {
  const uuid = z.string().uuid();

  const tools = [
    // --- Apply tools (script-builder-only) ---
    tool(
      'apply_script_code',
      'Write or replace the script code in the editor. Use this to deliver code to the user instead of putting it in a chat message.',
      {
        code: z.string().describe('The full script code to write into the editor'),
        language: z.enum(['powershell', 'bash', 'python', 'cmd']).describe('The scripting language'),
      },
      makeApplyHandler('apply_script_code', onPostToolUse)
    ),

    tool(
      'apply_script_metadata',
      'Set script metadata fields in the editor form (name, description, category, OS targets, parameters, etc.). Only include fields you want to change.',
      {
        name: z.string().max(255).optional().describe('Script name'),
        description: z.string().max(2000).optional().describe('Script description'),
        category: z.enum(['Maintenance', 'Security', 'Monitoring', 'Deployment', 'Backup', 'Network', 'User Management', 'Software', 'Custom']).optional(),
        osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).optional(),
        parameters: z.array(z.object({
          name: z.string(),
          type: z.enum(['string', 'number', 'boolean', 'select']),
          defaultValue: z.string().optional(),
          required: z.boolean().optional(),
          options: z.string().optional(),
        })).optional(),
        runAs: z.enum(['system', 'user', 'elevated']).optional(),
        timeoutSeconds: z.number().int().min(1).max(86400).optional(),
      },
      makeApplyHandler('apply_script_metadata', onPostToolUse)
    ),

    // --- Context tools (reuse existing handlers) ---
    tool(
      'query_devices',
      'Search and filter devices. Use to find devices by OS, status, or name for tailoring scripts.',
      {
        status: z.enum(['online', 'offline', 'maintenance', 'decommissioned']).optional(),
        osType: z.enum(['windows', 'macos', 'linux']).optional(),
        search: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      makeExistingHandler('query_devices', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_device_details',
      'Get device details including hardware, OS, network, and installed software.',
      { deviceId: uuid },
      makeExistingHandler('get_device_details', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_alerts',
      'Query alerts for a device or org. Use to understand what issue a script should address.',
      {
        action: z.literal('list'),
        alertId: uuid.optional(),
        status: z.enum(['active', 'acknowledged', 'resolved', 'suppressed']).optional(),
        severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
        deviceId: uuid.optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      makeExistingHandler('manage_alerts', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'list_scripts',
      'Search the existing script library. Use to find similar scripts or avoid duplicates.',
      {
        search: z.string().max(200).optional(),
        category: z.string().optional(),
        language: z.enum(['powershell', 'bash', 'python', 'cmd']).optional(),
        osType: z.enum(['windows', 'macos', 'linux']).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      makeExistingHandler('list_scripts', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_script_details',
      'Get full details of an existing script including code, parameters, and execution settings.',
      { scriptId: uuid },
      makeExistingHandler('get_script_details', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'list_script_templates',
      'Browse available script templates for common tasks.',
      {
        search: z.string().max(200).optional(),
        category: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      makeExistingHandler('list_script_templates', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_script_execution_history',
      'View past execution results for a script. Use to understand success rates and common failures.',
      {
        scriptId: uuid.describe('The script ID to get execution history for'),
        limit: z.number().int().min(1).max(50).optional(),
      },
      makeExistingHandler('get_script_execution_history', getAuth, onPreToolUse, onPostToolUse)
    ),

    // --- Execution tool (requires approval) ---
    tool(
      'execute_script_on_device',
      'Run a saved script on one or more devices. The script must be saved first. Requires user approval.',
      {
        scriptId: uuid.describe('The saved script ID to execute'),
        deviceIds: z.array(uuid).min(1).max(10).describe('Target device IDs'),
        parameters: z.record(z.unknown()).optional(),
      },
      makeExistingHandler('run_script', getAuth, onPreToolUse, onPostToolUse)
    ),
  ];

  return createSdkMcpServer({ name: 'script_builder', tools });
}
